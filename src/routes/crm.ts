import { Router } from "express";
import prisma from "../lib/prisma";

export const crmRouter = Router();

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
          const rowData = typeof existingRecord.rowData === 'object' && existingRecord.rowData !== null 
            ? { ...existingRecord.rowData } 
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
