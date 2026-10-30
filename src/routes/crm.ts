import { Router } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";

export const crmRouter = Router();

// GET /api/v1/crm/interactions - Monitoring list of all interaction history
crmRouter.get("/interactions", authenticate as any, async (req: AuthRequest, res, next) => {
  try {
    const specialAccess = (req.user?.specialAccess ?? "").toLowerCase();
    let isControl = specialAccess.includes("control");
    let isSystemAdmin = req.user?.user_role?.toLowerCase() === "administrator" || specialAccess.includes("administrator");

    if (!isControl && !isSystemAdmin && req.user?.id) {
      const userDb = await prisma.user.findUnique({
        where: { id: Number(req.user.id) },
        select: { specialAccess: true, user_role: true }
      });
      if (userDb?.specialAccess?.toLowerCase().includes("control")) isControl = true;
      if (userDb?.user_role?.toLowerCase() === "administrator" || userDb?.specialAccess?.toLowerCase().includes("administrator")) isSystemAdmin = true;
    }

    if (!isControl && !isSystemAdmin) {
      res.status(403).json({ success: false, error: "Forbidden: Control special access required", code: "FORBIDDEN_CONTROL_REQUIRED" });
      return;
    }

    const { date, dateFrom, dateTo, user, phone, status, page = "1", limit = "50" } = req.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * take;

    const where: any = {};

    if (phone && phone.trim()) {
      where.customerPhone = { contains: phone.trim() };
    }

    if (user && user.trim()) {
      where.OR = [
        { loggedByName: { contains: user.trim(), mode: "insensitive" } },
        { loggedByEmail: { contains: user.trim(), mode: "insensitive" } },
      ];
    }

    if (status && status.trim() && status.toUpperCase() !== "ALL") {
      where.status = { equals: status.trim(), mode: "insensitive" };
    }

    if (date && date.trim()) {
      const dStart = new Date(`${date.trim()}T00:00:00.000Z`);
      const dEnd = new Date(`${date.trim()}T23:59:59.999Z`);
      where.createdAt = { gte: dStart, lte: dEnd };
    } else {
      const dateFilter: any = {};
      if (dateFrom && dateFrom.trim()) {
        const dFrom = dateFrom.includes("T") ? new Date(dateFrom.trim()) : new Date(`${dateFrom.trim()}T00:00:00.000Z`);
        if (!isNaN(dFrom.getTime())) dateFilter.gte = dFrom;
      }
      if (dateTo && dateTo.trim()) {
        const dTo = dateTo.includes("T") ? new Date(dateTo.trim()) : new Date(`${dateTo.trim()}T23:59:59.999Z`);
        if (!isNaN(dTo.getTime())) dateFilter.lte = dTo;
      }
      if (Object.keys(dateFilter).length > 0) {
        where.createdAt = dateFilter;
      }
    }

    const [total, interactions] = await Promise.all([
      prisma.crmInteraction.count({ where }),
      prisma.crmInteraction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
    ]);

    res.json({
      success: true,
      data: interactions,
      meta: {
        page: pageNum,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/crm/search
crmRouter.get("/search", async (req, res, next) => {
  try {
    const query = req.query.q as string;
    if (!query || typeof query !== 'string') {
      res.json([]);
      return;
    }

    // Normalize phone by removing +234, 234, or leading 0
    let cleanQuery = query.replace(/^\+?234|^0/, '');
    
    // Require at least 3 digits to perform a meaningful contains search
    if (cleanQuery.length < 3) {
      res.json([]);
      return;
    }

    const interactions = await prisma.crmInteraction.findMany({
      where: {
        customerPhone: {
          contains: cleanQuery
        }
      },
      select: {
        customerPhone: true
      },
      distinct: ['customerPhone'],
      take: 10
    });

    const phones = interactions.map(i => i.customerPhone);
    res.json(phones);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/crm/:phone
crmRouter.get("/:phone", async (req, res, next) => {
  try {
    const { phone } = req.params;

    if (!phone) {
      res.status(400).json({ error: "Phone number is required." });
      return;
    }

    const interactions = await prisma.crmInteraction.findMany({
      where: {
        customerPhone: phone,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json(interactions);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/crm
crmRouter.post("/", async (req, res, next) => {
  try {
    const { customerPhone, sourceType, sourceId, feedbackText, status, loggedByEmail: bodyLoggedByEmail, loggedByName: bodyLoggedByName } = req.body;

    const loggedByEmail = bodyLoggedByEmail || "Unknown";
    const loggedByName = bodyLoggedByName || "Unknown User";

    if (!customerPhone || !status) {
      res.status(400).json({ error: "Missing required fields (customerPhone, status)." });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const interaction = await tx.crmInteraction.create({
        data: {
          customerPhone,
          sourceType: sourceType ?? "UNKNOWN",
          sourceId: sourceId ?? "UNKNOWN",
          feedbackText: feedbackText || "",
          status,
          loggedByEmail,
          loggedByName,
        },
      });

      let updatedRecord = null;
      if (sourceType === "UPLOADED_DATA" && sourceId && sourceId !== "UNKNOWN") {
        const existingRecord = await tx.datasetRecord.findUnique({
          where: { id: sourceId }
        });
        
        if (existingRecord) {
          const existingData = (existingRecord.rowData as any) || {};
          const rowData = typeof existingData === 'object' && !Array.isArray(existingData) 
            ? { ...existingData } 
            : {};
          
          updatedRecord = await tx.datasetRecord.update({
            where: { id: sourceId },
            data: {
              rowData: {
                ...rowData,
                "CRM Status": status,
                "Latest Feedback": feedbackText,
                "Last Caller": loggedByName,
                "Last Call Time": new Date().toLocaleString()
              }
            }
          });
        }
      }

      return { interaction, updatedRecord };
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

export default crmRouter;
