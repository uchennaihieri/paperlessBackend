import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { downloadFromSharePoint } from "../lib/sharepoint";
import Handlebars from "handlebars";
import { launchBrowser } from "../lib/puppeteerBrowser";

const router = Router();
router.use(authenticate as any);

// ── Data Dictionary — canonical paths for every HTML render ──────────────────
// Hoisted here so the /data-dictionary endpoint can reference it before any
// /:id route is registered.
const DATA_DICTIONARY = [
  // Metadata / flat aliases (used in most templates)
  { category: "Metadata",    path: "formName",                        label: "Form Name" },
  { category: "Metadata",    path: "formDate",                        label: "Form Date (DD/MM/YYYY)" },
  { category: "Metadata",    path: "DateNow",                         label: "Current Date (Now)" },
  { category: "Metadata",    path: "TimeNow",                         label: "Current Time (Now)" },
  { category: "Metadata",    path: "dateSubmitted",                   label: "Date Submitted" },
  { category: "Metadata",    path: "reference",                       label: "Reference Code" },
  // Submitter
  { category: "Submitter",   path: "submittedBy",                     label: "Submitter Name" },
  { category: "Submitter",   path: "submitterEmail",                  label: "Submitter Email" },
  { category: "Submitter",   path: "submitterBranch",                 label: "Submitter Branch" },
  // Form Responses — responses is an ARRAY [{question, answer}]
  { category: "Form Data",   path: "responses",                       label: "Form Responses (Array)" },
  { category: "Form Data",   path: "Questions",                       label: "Form Questions (Array)" },
  { category: "Form Data",   path: "Responses",                       label: "Raw Responses Object" },
  // Signatories — array of signatories with: name, jobTitle, signatureUrl, dateTime
  { category: "Signatories", path: "signatories",                     label: "All Signatories (Array)" },
  { category: "Signatories", path: "Signatories.0.name",              label: "Signatory 1 — Name" },
  { category: "Signatories", path: "Signatories.0.email",             label: "Signatory 1 — Email" },
  { category: "Signatories", path: "Signatories.0.jobTitle",          label: "Signatory 1 — Job Title" },
  { category: "Signatories", path: "Signatories.0.status",            label: "Signatory 1 — Status" },
  { category: "Signatories", path: "Signatories.0.signatureImage",    label: "Signatory 1 — Signature Image" },
  { category: "Signatories", path: "Signatories.0.signatureUrl",      label: "Signatory 1 — Signature URL" },
  { category: "Signatories", path: "Signatories.0.dateSigned",        label: "Signatory 1 — Date Signed" },
  { category: "Signatories", path: "Signatories.0.dateTime",          label: "Signatory 1 — Date & Time" },
  { category: "Signatories", path: "Signatories.1.name",              label: "Signatory 2 — Name" },
  { category: "Signatories", path: "Signatories.1.jobTitle",          label: "Signatory 2 — Job Title" },
  { category: "Signatories", path: "Signatories.1.signatureUrl",      label: "Signatory 2 — Signature URL" },
  { category: "Signatories", path: "Signatories.1.dateSigned",        label: "Signatory 2 — Date Signed" },
  { category: "Signatories", path: "Signatories.1.dateTime",          label: "Signatory 2 — Date & Time" },
  
  // Contract Data
  { category: "Contract Data", path: "Contract.status",                 label: "Contract Status" },
  { category: "Contract Data", path: "Contract.internalSignerJobTitle", label: "Internal Signer Job Title" },
  { category: "Contract Data", path: "Contract.internalSignatureImage", label: "Internal Signer Signature" },
  { category: "Contract Data", path: "Contract.externalSignerName",     label: "External Signer Name" },
  { category: "Contract Data", path: "Contract.externalSignerEmail",    label: "External Signer Email" },
  { category: "Contract Data", path: "Contract.externalSignedDate",     label: "External Signed Date" },
  { category: "Contract Data", path: "Contract.externalSignatureImage", label: "External Signer Signature" },

  // Final Approver Data
  { category: "Final Approver", path: "FinalApprover.name",           label: "Final Approver Name" },
  { category: "Final Approver", path: "FinalApprover.email",          label: "Final Approver Email" },
  { category: "Final Approver", path: "FinalApprover.jobTitle",       label: "Final Approver Job Title" },
  { category: "Final Approver", path: "FinalApprover.signatureImage", label: "Final Approver Signature" },
];

// GET /api/v1/templates[?type=document|html]
router.get("/", async (req: Request, res: Response) => {
  const typeFilter = req.query.type as string | undefined;
  const availableFor = req.query.availableFor as string | undefined;
  
  const where: any = {};
  if (typeFilter) where.type = typeFilter;
  if (availableFor) where.availableFor = { has: availableFor };

  const templates = await prisma.pdfTemplate.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  res.json({ success: true, data: templates });
});

// GET /api/v1/templates/data-dictionary
// Returns the canonical data dictionary plus any custom fields from linked FormTemplates.
// Must be registered BEFORE /:id to avoid Express treating "data-dictionary" as an id param.
router.get("/data-dictionary", async (req: Request, res: Response) => {
  const formTemplateId = req.query.formTemplateId as string | undefined;
  let dynamicDict: typeof DATA_DICTIONARY = [];

  if (formTemplateId) {
    try {
      const formTemplate = await prisma.formTemplate.findUnique({
        where: { id: formTemplateId }
      });

      if (formTemplate) {
        const fields = (formTemplate.fields as any[]) || [];
        for (const f of fields) {
          if (f.isPrerequisite && f.targetFormTemplateId) {
            try {
              const targetForm = await prisma.formTemplate.findUnique({ where: { id: f.targetFormTemplateId } });
              if (targetForm) {
                const targetFields = (targetForm.fields as any[]) || [];
                const catName = `Prerequisite: ${targetForm.name}`;
                const prereqBase = `Prerequisites.[${targetForm.name}]`;
                
                // Common Prerequisite Metadata & Signatories
                dynamicDict.push({ category: catName, path: `${prereqBase}.Metadata.dateSubmitted`, label: "Date Submitted" });
                dynamicDict.push({ category: catName, path: `${prereqBase}.Signatories.0.name`, label: "Signatory 1 Name" });
                dynamicDict.push({ category: catName, path: `${prereqBase}.Signatories.0.email`, label: "Signatory 1 Email" });
                dynamicDict.push({ category: catName, path: `${prereqBase}.Signatories.0.dateSigned`, label: "Signatory 1 Date Signed" });

                // Prerequisite Input Fields
                for (const tf of targetFields) {
                  if (tf.label) {
                    const safeLabel = tf.label.includes(" ") ? `[${tf.label}]` : tf.label;
                    dynamicDict.push({
                      category: catName,
                      path: `${prereqBase}.Responses.${safeLabel}`,
                      label: tf.label
                    });
                  }
                }
              }
            } catch (err) {
              console.error("Error fetching prerequisite fields:", err);
            }
          }
        }
      }
    } catch (err) {
      console.error("Error fetching dynamic dictionary fields:", err);
    }
  }

  res.json({ success: true, data: [...DATA_DICTIONARY, ...dynamicDict] });
});

// POST /api/v1/templates
// Body: { name, type, sharepointPath, availableFor }
// Frontend auto-prefixes sharepointPath based on type:
//   document → "templates/<filename>.pdf"
//   html     → "htmltemplates/<filename>.html"
router.post("/", async (req: Request, res: Response) => {
  const { name, sharepointPath, type, availableFor } = req.body;
  if (!name || !sharepointPath) {
    res.status(400).json({ success: false, error: "name and sharepointPath are required", code: "NAME_AND_SHAREPOINTPATH_ARE_RE" });
    return;
  }
  const templateType = type === "html" ? "html" : "document";
  try {
    const template = await prisma.pdfTemplate.create({
      data: { 
        name: name.toUpperCase(), 
        sharepointPath, 
        type: templateType,
        availableFor: Array.isArray(availableFor) && availableFor.length > 0 ? availableFor : ["forms"]
      } as any,
    });
    res.status(201).json({ success: true, data: template });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ success: false, error: "Template with this name already exists", code: "TEMPLATE_WITH_THIS_NAME_ALREAD" });
    } else {
      res.status(500).json({ success: false, error: "Internal Server Error", code: "INTERNAL_SERVER_ERROR" });
    }
  }
});

// GET /api/v1/templates/:id
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const template = await prisma.pdfTemplate.findUnique({
    where: { id },
    include: { fields: true },
  });
  if (!template) {
    res.status(404).json({ success: false, error: "Template not found", code: "TEMPLATE_NOT_FOUND" });
    return;
  }
  res.json({ success: true, data: template });
});

// PATCH /api/v1/templates/:id
router.patch("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, sharepointPath, availableFor } = req.body;
  try {
    const template = await prisma.pdfTemplate.update({
      where: { id },
      data: { 
        name: name ? name.toUpperCase() : undefined, 
        sharepointPath, 
        availableFor 
      } as any,
    });
    res.json({ success: true, data: template });
  } catch (err: any) {
    res.status(500).json({ success: false, error: "Failed to update template", code: "FAILED_TO_UPDATE_TEMPLATE" });
  }
});

// DELETE /api/v1/templates/:id
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.pdfTemplate.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to delete template", code: "FAILED_TO_DELETE_TEMPLATE" });
  }
});

// POST /api/v1/templates/:id/extract-fields
router.post("/:id/extract-fields", async (req: Request, res: Response) => {
  const { id } = req.params;
  const template = await prisma.pdfTemplate.findUnique({ where: { id } });
  
  if (!template) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }
  if (template.type !== "html") {
    res.status(400).json({ success: false, error: "Extraction is only supported for HTML templates" });
    return;
  }

  try {
    const { buffer } = await downloadFromSharePoint(template.sharepointPath);
    const content = buffer.toString("utf-8");

    const extractedFields: { name: string; type: "text" | "block" }[] = [];
    
    const addField = (name: string, type: "text" | "block") => {
      // Split by space to handle things like {{field_name fallback}} or simple helpers, taking the first token
      const cleanName = name.trim().split(" ")[0]; 
      if (!cleanName || cleanName === "else") return;
      if (!extractedFields.find(f => f.name === cleanName)) {
        extractedFields.push({ name: cleanName, type });
      }
    };

    // Step 1: Extract standard Handlebars fields {{field_name}}
    // Regex matches {{ followed by anything except #, /, >, or space, then closing }}
    // The (?<!\\) ensures we IGNORE \{{escaped}} fields which are auto-computed by JS
    const standardRegex = /(?<!\\)\{\{([^#\/\s>][^}]*)\}\}/g;
    let match;
    while ((match = standardRegex.exec(content)) !== null) {
      addField(match[1], "text");
    }

    // Step 3: Extract conditional block fields {{#if field_name}}
    const ifRegex = /\{\{#if\s+([^}]+)\}\}/g;
    while ((match = ifRegex.exec(content)) !== null) {
      addField(match[1], "block");
    }

    res.json({ success: true, data: extractedFields });
  } catch (err: any) {
    console.error("Extraction error:", err);
    res.status(500).json({ success: false, error: "Failed to extract fields: " + err.message });
  }
});

// GET /api/v1/templates/:id/file
// • document type → streams the PDF binary (for canvas preview)
// • html type     → streams the raw HTML text (for source inspection)
router.get("/:id/file", async (req: Request, res: Response) => {
  const { id } = req.params;
  const template = await prisma.pdfTemplate.findUnique({ where: { id } });
  if (!template) {
    res.status(404).json({ success: false, error: "Template not found", code: "TEMPLATE_NOT_FOUND" });
    return;
  }

  try {
    const { buffer } = await downloadFromSharePoint(template.sharepointPath);
    if (template.type === "html") {
      res.set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
    } else {
      res.set({
        "Content-Type": "application/pdf",
        "Cache-Control": "public, max-age=300",
      });
    }
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, code: "INTERNALSERVERERROR" });
  }
});

// GET /api/v1/templates/:id/fields
router.get("/:id/fields", async (req: Request, res: Response) => {
  const { id } = req.params;
  const fields = await prisma.pdfTemplateField.findMany({ where: { templateId: id } });
  res.json({ success: true, data: fields });
});




// POST /api/v1/templates/:id/fields
// For html-type templates x/y/width/height can be 0 — only name and type matter.
// mappingPath can be optionally provided.
router.post("/:id/fields", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, type, mappingPath, page, x, y, width, height } = req.body;

  try {
    const field = await prisma.pdfTemplateField.create({
      data: {
        templateId: id,
        name,
        type,
        mappingPath: mappingPath ?? null,
        page: page ?? 0,
        x: x ?? 0,
        y: y ?? 0,
        width: width ?? 0,
        height: height ?? 0,
      }
    });
    res.status(201).json({ success: true, data: field });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to create field", code: "FAILED_TO_CREATE_FIELD" });
  }
});

// PUT /api/v1/templates/:id/fields/:fid
router.put("/:id/fields/:fid", async (req: Request, res: Response) => {
  const { fid } = req.params;
  const { name, type, mappingPath, page, x, y, width, height } = req.body;

  try {
    const field = await prisma.pdfTemplateField.update({
      where: { id: fid },
      data: { name, type, mappingPath: mappingPath ?? null, page, x, y, width, height }
    });
    res.json({ success: true, data: field });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to update field", code: "FAILED_TO_UPDATE_FIELD" });
  }
});

// DELETE /api/v1/templates/:id/fields/:fid
router.delete("/:id/fields/:fid", async (req: Request, res: Response) => {
  const { fid } = req.params;
  try {
    await prisma.pdfTemplateField.delete({ where: { id: fid } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to delete field", code: "FAILED_TO_DELETE_FIELD" });
  }
});




// POST /api/v1/templates/:id/sync-fields
// Bulk upsert: called by the Designer when the admin hits "Save All".
// Body: { fields: [{ name, mappingPath, type }] }
router.post("/:id/sync-fields", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { fields } = req.body as { fields: { name: string; mappingPath: string | null; type: string }[] };

  if (!Array.isArray(fields)) {
    res.status(400).json({ success: false, error: "fields array required", code: "FIELDS_ARRAY_REQUIRED" });
    return;
  }

  try {
    // Delete all existing fields then recreate (cleanest approach for full sync)
    await prisma.pdfTemplateField.deleteMany({ where: { templateId: id } });
    const created = await prisma.pdfTemplateField.createMany({
      data: fields.map((f) => ({
        templateId: id,
        name: f.name,
        type: f.type ?? "text",
        mappingPath: f.mappingPath ?? null,
        page: 0, x: 0, y: 0, width: 0, height: 0,
      })),
    });
    res.json({ success: true, count: created.count });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, code: "INTERNALSERVERERROR" });
  }
});

// GET /api/v1/templates/:id/generate-test-pdf
// Renders the HTML template with dummy data and streams a PDF back inline.
// This is a pure read+render+stream — nothing is saved to DB or SharePoint.
router.get("/:id/generate-test-pdf", async (req: Request, res: Response) => {
  try {
    const template = await prisma.pdfTemplate.findUnique({
      where: { id: req.params.id },
      include: { fields: true },
    });

    if (!template) {
      res.status(404).json({ success: false, error: "Template not found", code: "TEMPLATE_NOT_FOUND" });
      return;
    }
    if ((template as any).type !== "html") {
      res.status(400).json({ success: false, error: "Only HTML templates support test PDF generation", code: "ONLY_HTML_TEMPLATES_SUPPORT_TE" });
      return;
    }

    // 1. Download HTML source from SharePoint
    let htmlSource: string;
    try {
      const { buffer } = await downloadFromSharePoint(template.sharepointPath);
      htmlSource = buffer.toString("utf-8");
    } catch (e: any) {
      res.status(502).json({ success: false, error: `Could not download HTML from SharePoint: ${e.message}`, code: "COULD_NOT_DOWNLOAD_HTML_FROM_S" });
      return;
    }

    // 2. Blank 1×1 transparent PNG — prevents broken image icons in the preview
    const BLANK_SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    // 3. Build dummy context — same shape as the real unified context in pdfGenerator
    const dummySig1 = {
      index: 1, name: "First Approver", email: "approver1@example.com",
      jobTitle: "Line Manager", status: "Signed",
      dateSigned: "19/04/2026", timeSigned: "09:15:00",
      dateTime: "19/04/2026, 09:15:00",
      signatureImage: BLANK_SIG, signatureUrl: BLANK_SIG,
    };
    const dummySig2 = {
      index: 2, name: "Second Approver", email: "approver2@example.com",
      jobTitle: "Department Head", status: "Signed",
      dateSigned: "19/04/2026", timeSigned: "10:30:00",
      dateTime: "19/04/2026, 10:30:00",
      signatureImage: BLANK_SIG, signatureUrl: BLANK_SIG,
    };
    const dummyQuestions = [
      { index: 1, label: "Sample Question 1", value: "Sample Answer 1" },
      { index: 2, label: "Sample Question 2", value: "Sample Answer 2" },
      { index: 3, label: "Amount (₦)",        value: "5,000.00" },
    ];

    const ctx: Record<string, any> = {
      // Structured
      Metadata: {
        formTitle:     "Test Form — Preview",
        reference:     "TEST-001",
        dateSubmitted: "19/04/2026",
        dateTime:      "19/04/2026, 09:00:00",
        submitter: { name: "Test User", email: "testuser@finca.ng", branch: "HEAD OFFICE" },
      },
      Questions:   dummyQuestions,
      Responses:   { "Sample Question 1": "Sample Answer 1", "Sample Question 2": "Sample Answer 2", "Amount (₦)": "5,000.00" },
      Signatories: [dummySig1, dummySig2],
      // Flat aliases
      formTitle:       "Test Form — Preview",
      formName:        "Test Form — Preview",
      formDate:        "19/04/2026",
      dateSubmitted:   "19/04/2026, 09:00:00",
      reference:       "TEST-001",
      submittedBy:     "Test User",
      submitterEmail:  "testuser@finca.ng",
      submitterBranch: "HEAD OFFICE",
      questions:       dummyQuestions,
      responses:       dummyQuestions.map((q) => ({ question: q.label, answer: q.value })),
      signatories:     [dummySig1, dummySig2],
      sign_name:       dummySig1.name,
      signature:       BLANK_SIG,
      signTime:        dummySig1.dateSigned,
    };

    // 4. Inject Form-Builder-mapped fields as obvious placeholder values
    for (const field of template.fields as any[]) {
      if (!field.mappingPath) {
        ctx[field.name] = `[${field.name} — test value]`;
      }
    }

    // 5. Compile with Handlebars
    let rendered: string;
    try {
      rendered = Handlebars.compile(htmlSource)(ctx);
    } catch (e: any) {
      res.status(422).json({ success: false, error: `Handlebars compile error: ${e.message}`, code: "HANDLEBARS_COMPILE_ERROR_EMESS" });
      return;
    }

    // 6. Render to PDF via Puppeteer
    try {
      const browser = await launchBrowser();
      const pg = await browser.newPage();
      await pg.setContent(rendered, { waitUntil: "networkidle0" });
      const pdfBuffer = await pg.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      });
      await browser.close();

      // 7. Stream inline so the browser opens the PDF viewer
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="preview_${template.id}.pdf"`);
      res.send(Buffer.from(pdfBuffer));

    } catch (e: any) {
      res.status(500).json({ success: false, error: `PDF render failed: ${e.message}`, code: "PDF_RENDER_FAILED_EMESSAGE" });
    }

  } catch (e: any) {
    console.error("[generate-test-pdf]", e);
    res.status(500).json({ success: false, error: `Unexpected error: ${e.message}`, code: "UNEXPECTED_ERROR_EMESSAGE" });
  }
});

export default router;

