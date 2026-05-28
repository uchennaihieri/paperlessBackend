import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/authenticate";

const router = Router();

// All form-template endpoints require a valid session
router.use(authenticate as any);

// ── GET /api/v1/forms ─────────────────────────────────────────────────────────
router.get("/", async (req: AuthRequest, res: Response) => {
  const userRole = (req.user?.user_role ?? "").toLowerCase();
  const specialAccess = (req.user?.specialAccess ?? "").toLowerCase();
  const isAdmin = userRole === "administrator" || userRole === "admin" || userRole === "superadmin" || specialAccess.includes("administrator");
  const email = req.user?.email?.toLowerCase() ?? "";

  let templates;
  if (isAdmin) {
    templates = await prisma.formTemplate.findMany({ orderBy: { createdAt: "asc" } });
  } else {
    const branch = req.user?.branch ?? "";

    // Only return forms the user has been explicitly assigned to OR if the form owner matches their branch
    const accessRecords = await prisma.formAccess.findMany({
      where: { userEmail: email },
      select: { templateId: true }
    });
    const templateIds = accessRecords.map(a => a.templateId);
    
    const whereClause: any = { isInternal: false };
    if (branch) {
      whereClause.OR = [
        { id: { in: templateIds } },
        { formOwner: branch }
      ];
    } else {
      whereClause.id = { in: templateIds };
    }

    templates = await prisma.formTemplate.findMany({
      where: whereClause,
      orderBy: { createdAt: "asc" }
    });
  }

  res.json({ success: true, data: templates });
});

// ── GET /api/v1/forms/branches ────────────────────────────────────────────────
router.get("/branches", async (_req, res: Response) => {
  const rows = await prisma.user.findMany({
    where: { branch: { not: null }, status: { equals: "active", mode: "insensitive" } },
    select: { branch: true },
    distinct: ["branch"],
    orderBy: { branch: "asc" },
  });
  const branches = rows.map((r) => r.branch!).filter(Boolean);
  res.json({ success: true, data: branches });
});

// ── GET /api/v1/forms/search-users ───────────────────────────────────────────
router.get("/search-users", async (req, res: Response) => {
  const query = (req.query.q ?? "") as string;
  if (!query || query.length < 2) {
    res.json({ success: true, data: [] });
    return;
  }
  const users = await prisma.user.findMany({
    where: {
      status: { equals: "active", mode: "insensitive" },
      OR: [
        { user_name: { contains: query, mode: "insensitive" } },
        { finca_email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { id: true, user_name: true, finca_email: true, branch: true, user_role: true },
    take: 15,
  });
  res.json({ success: true, data: users });
});

// ── GET /api/v1/forms/dynamic-options ─────────────────────────────────────────
router.get("/dynamic-options", async (req, res: Response) => {
  const tableName = (req.query.table ?? "") as string;
  if (!tableName || !/^[a-zA-Z0-9_]+$/.test(tableName)) {
    res.status(400).json({ success: false, error: "Invalid or missing table name" });
    return;
  }

  try {
    // The user requested a single column named "Options". We map it to 'value' and 'label' for standard frontend usage.
    const query = `SELECT DISTINCT "Options" as option FROM "${tableName}" WHERE "Options" IS NOT NULL`;
    const rows = await prisma.$queryRawUnsafe<any[]>(query);
    const options = rows.map((r) => ({
      value: r.option,
      label: r.option,
    }));
    res.json({ success: true, data: options });
  } catch (err) {
    console.error(`Error fetching dynamic options from table ${tableName}:`, err);
    res.status(500).json({ success: false, error: "Failed to fetch dynamic options. Verify the table and 'Options' column exist." });
  }
});

// ── GET /api/v1/forms/extended-options ────────────────────────────────────────
router.get("/extended-options", async (req, res: Response) => {
  const service = (req.query.service ?? "") as string;
  if (!service) {
    res.status(400).json({ success: false, error: "Missing service parameter" });
    return;
  }

  try {
    const options: { value: string, label: string }[] = [];

    if (service === "nin" || service === "bvn") {
      const logs = await prisma.identityVerificationLog.findMany({
        where: { idType: service as any },
        orderBy: { createdAt: "desc" },
      });
      for (const log of logs) {
        const dateStr = log.createdAt.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
        const name = log.subjectName || "Unknown";
        options.push({
          value: log.reference,
          label: `${name} - ${log.idNumber || log.reference} - ${dateStr}`,
        });
      }
    } else if (service === "firstcentral" || service === "creditregistry") {
      const logs = await prisma.creditBureauLog.findMany({
        where: { bureau: service },
        orderBy: { createdAt: "desc" },
      });
      for (const log of logs) {
        const dateStr = log.createdAt.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
        const name = log.subjectName || "Unknown";
        options.push({
          value: log.reference,
          label: `${name} - ${log.bvn || log.reference} - ${dateStr}`,
        });
      }
    } else {
      res.status(400).json({ success: false, error: "Invalid service type" });
      return;
    }

    res.json({ success: true, data: options });
  } catch (err) {
    console.error(`Error fetching extended options for service ${service}:`, err);
    res.status(500).json({ success: false, error: "Failed to fetch extended options." });
  }
});

// ── GET /api/v1/forms/excel-enabled ──────────────────────────────────────────
router.get("/excel-enabled", async (req: AuthRequest, res: Response) => {
  const userRole = (req.user?.user_role ?? "").toLowerCase();
  const specialAccess = (req.user?.specialAccess ?? "").toLowerCase();
  const isAdmin = userRole === "administrator" || userRole === "admin" || userRole === "superadmin" || specialAccess.includes("administrator");
  const email = req.user?.email?.toLowerCase() ?? "";

  let templates;
  if (isAdmin) {
    templates = await prisma.formTemplate.findMany({ 
      where: { generatesExcel: true },
      orderBy: { name: "asc" } 
    });
  } else {
    const branch = req.user?.branch ?? "";

    // Return excel-enabled forms the user has access to or if their branch matches the form owner
    const accessRecords = await prisma.formAccess.findMany({
      where: { userEmail: email },
      select: { templateId: true }
    });
    const templateIds = accessRecords.map(a => a.templateId);
    
    const whereClause: any = { generatesExcel: true };
    if (branch) {
      whereClause.OR = [
        { id: { in: templateIds } },
        { formOwner: branch }
      ];
    } else {
      whereClause.id = { in: templateIds };
    }

    templates = await prisma.formTemplate.findMany({
      where: whereClause,
      orderBy: { name: "asc" }
    });
  }
  res.json({ success: true, data: templates });
});

// ── GET /api/v1/forms/:id ──────────────────────────────────────────────────────
router.get("/:id", async (req: AuthRequest, res: Response) => {
  const template = await prisma.formTemplate.findUnique({ where: { id: req.params.id } });
  if (!template) {
    res.status(404).json({ success: false, error: "Form template not found" });
    return;
  }

  const userRole = (req.user?.user_role ?? "").toLowerCase();
  const specialAccess = (req.user?.specialAccess ?? "").toLowerCase();
  const isAdmin = userRole === "administrator" || userRole === "admin" || userRole === "superadmin" || specialAccess.includes("administrator");
  const email = req.user?.email?.toLowerCase() ?? "";

  if (!isAdmin) {
    const branch = req.user?.branch ?? "";
    
    // Check if the user's branch matches the form owner
    if (branch && template.formOwner === branch) {
      // Access granted
    } else {
      // Check if the user has access to this specific form
      const access = await prisma.formAccess.findUnique({
        where: {
          templateId_userEmail: {
            templateId: req.params.id,
            userEmail: email,
          }
        }
      });
      if (!access) {
        res.status(403).json({ success: false, error: "You do not have access to this form." });
        return;
      }
    }
  }

  res.json({ success: true, data: template });
});

// ── POST /api/v1/forms ─────────────────────────────────────────────────────────
router.post("/", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { name, description, fields, formOwner, formTreater, htmlTemplate, pdfGeneratorType, generatesExcel, pdfTemplateId, mobileEnabled, accountServicesEnabled, isInternal, needsContract, contractTemplateId } = req.body;
  try {
    const template = await prisma.formTemplate.create({
      data: {
        name,
        description,
        mobileEnabled: mobileEnabled ?? false,
        accountServicesEnabled: accountServicesEnabled ?? false,
        isInternal: isInternal ?? false,
        fields,
        formOwner: formOwner ?? null,
        formTreater: formTreater ?? null,
        htmlTemplate: htmlTemplate ?? null,
        pdfGeneratorType: pdfGeneratorType ?? "none",
        generatesExcel: generatesExcel ?? false,
        pdfTemplateId: pdfTemplateId || null,
        needsContract: needsContract ?? false,
        contractTemplateId: contractTemplateId || null,
      },
    });
    res.status(201).json({ success: true, data: template });

  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ success: false, error: "A form with this name already exists." });
    } else {
      throw err;
    }
  }
});

// ── PATCH /api/v1/forms/:id ───────────────────────────────────────────────────
router.patch("/:id", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { name, description, fields, formOwner, formTreater, htmlTemplate, pdfGeneratorType, generatesExcel, pdfTemplateId, mobileEnabled, accountServicesEnabled, isInternal, needsContract, contractTemplateId } = req.body;
  try {
    const template = await prisma.formTemplate.update({
      where: { id: req.params.id },
      data: {
        name,
        description,
        mobileEnabled: mobileEnabled ?? false,
        accountServicesEnabled: accountServicesEnabled ?? false,
        isInternal: isInternal ?? false,
        fields,
        formOwner: formOwner ?? null,
        formTreater: formTreater ?? null,
        htmlTemplate: htmlTemplate ?? null,
        pdfGeneratorType: pdfGeneratorType ?? "none",
        generatesExcel: generatesExcel ?? false,
        pdfTemplateId: pdfTemplateId || null,
        needsContract: needsContract ?? false,
        contractTemplateId: contractTemplateId || null,
      },
    });
    res.json({ success: true, data: template });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ success: false, error: "A form with this name already exists." });
    } else {
      throw err;
    }
  }
});

// ── DELETE /api/v1/forms/:id ──────────────────────────────────────────────────
router.delete("/:id", requireAdmin as any, async (req, res: Response) => {
  try {
    await prisma.formTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    if (err?.code === "P2003") {
      res.status(409).json({ success: false, error: "Cannot delete this template because it has existing submissions. Please delete the submissions first." });
    } else {
      res.status(500).json({ success: false, error: "Failed to delete form template." });
    }
  }
});

export default router;
