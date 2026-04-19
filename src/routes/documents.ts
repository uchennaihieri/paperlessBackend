import { Router, Request, Response } from "express";
import { PDFDocument, rgb } from "pdf-lib";
import Handlebars from "handlebars";
import puppeteer from "puppeteer";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { downloadFromSharePoint } from "../lib/sharepoint";

const router = Router();
router.use(authenticate as any);

// POST /api/v1/documents/generate
// Body: { templateId, data }
//   data — key/value map of field names → values
//
// Supports both template types:
//   "document" → pdf-lib overlay on the base PDF (existing behaviour)
//   "html"     → Handlebars compile + Puppeteer render
router.post("/generate", async (req: Request, res: Response) => {
  const { templateId, data } = req.body;
  if (!templateId || !data) {
    res.status(400).json({ success: false, error: "templateId and data are required" });
    return;
  }

  try {
    const template = await prisma.pdfTemplate.findUnique({
      where: { id: templateId },
      include: { fields: true }
    });

    if (!template) {
      res.status(404).json({ success: false, error: "Template not found" });
      return;
    }

    // ── HTML Handlebars + Puppeteer path ─────────────────────────────────────
    if (template.type === "html") {
      const { buffer: htmlBuffer } = await downloadFromSharePoint(template.sharepointPath);
      const htmlSource = htmlBuffer.toString("utf-8");

      // Build questions array from data (skip isAttachment entries)
      const questionList: { index: number; label: string; value: string }[] = [];
      let qIndex = 1;
      const flatData = data as Record<string, any>;
      for (const [label, val] of Object.entries(flatData)) {
        if (["formName", "reference", "dateSubmitted", "signatories", "responses"].includes(label)) continue;
        if (Array.isArray(val) && (val[0]?.isAttachment)) continue;
        const displayVal = Array.isArray(val) ? val.join(", ") : String(val ?? "");
        questionList.push({ index: qIndex++, label, value: displayVal });
      }

      const signatories: any[] = Array.isArray(data.signatories) ? data.signatories : [];
      const firstSig = signatories[0];

      const compiled = Handlebars.compile(htmlSource);
      const html = compiled({
        // Individual mapped variables
        ...flatData,

        // Metadata aliases (override with well-known names)
        formTitle:      flatData.formName ?? "",
        formName:       flatData.formName ?? "",
        formDate:       flatData.dateSubmitted ?? new Date().toLocaleDateString("en-GB"),
        formDateTime:   flatData.dateSubmitted ?? new Date().toLocaleString(),
        dateSubmitted:  flatData.dateSubmitted ?? new Date().toLocaleString(),
        reference:      flatData.reference ?? "",
        formCode:       (flatData.reference ?? "").toUpperCase(),
        submittedBy:    flatData.submittedBy ?? "",
        submitterEmail: flatData.submitterEmail ?? "",
        submitterBranch:flatData.submitterBranch ?? "",

        // Aggregate Q&A
        responses: flatData.responses ?? flatData,
        questions: questionList,

        // Primary signatory aliases
        sign_name: firstSig?.userName ?? firstSig?.sign_name ?? "",
        signRole:  firstSig?.signRole ?? "Signatory",
        signature: firstSig?.signatureData ?? firstSig?.signature ?? "",
        signTime:  firstSig?.signedAt ?? firstSig?.signTime ?? "",

        // Full signatories array with convenience aliases
        signatories: signatories.map((s: any, idx: number) => ({
          ...s,
          index:         idx + 1,
          sign_name:     s.userName ?? s.sign_name ?? "",
          signRole:      s.signRole ?? (idx === 0 ? "Primary Signatory" : `Signatory ${idx + 1}`),
          signature:     s.signatureData ?? s.signature ?? "",
          signTime:      s.signedAt ?? s.signTime ?? "",
        })),
      });

      let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
      try {
        browser = await puppeteer.launch({ headless: true, channel: "chrome" });
      } catch {
        browser = await puppeteer.launch({ headless: true, channel: "msedge" as any });
      }

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
      await browser.close();

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${template.name.replace(/\s+/g, "_")}-preview.pdf"`,
      });
      res.send(Buffer.from(pdfBuffer));
      return;
    }

    // ── Document pdf-lib overlay path (existing) ──────────────────────────────
    const { buffer: pdfBuffer } = await downloadFromSharePoint(template.sharepointPath);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();

    for (const field of template.fields) {
      const val = data[field.name];
      if (!val) continue;

      const pageIndex = field.page ?? 0;
      if (pageIndex >= pages.length || pageIndex < 0) continue;

      const pdfPage = pages[pageIndex];
      const { width: pWidth, height: pHeight } = pdfPage.getSize();

      const x      = field.x * pWidth;
      const y      = (1 - field.y - field.height) * pHeight;
      const fWidth  = field.width * pWidth;
      const fHeight = field.height * pHeight;

      if (field.type === "image" || field.type === "signature") {
        let imageBytes: Buffer;
        let image;
        try {
          if (val.startsWith("data:image/jpeg") || val.startsWith("data:image/jpg")) {
            imageBytes = Buffer.from(val.split(",")[1], "base64");
            image = await pdfDoc.embedJpg(imageBytes);
          } else if (val.startsWith("data:image/png") || val.startsWith("data:image/")) {
            imageBytes = Buffer.from(val.split(",")[1], "base64");
            image = await pdfDoc.embedPng(imageBytes);
          } else {
            imageBytes = Buffer.from(val, "base64");
            image = await pdfDoc.embedPng(imageBytes).catch(() => pdfDoc.embedJpg(imageBytes));
          }
          if (image) {
            pdfPage.drawImage(image, { x, y, width: fWidth, height: fHeight });
          }
        } catch (e) {
          console.error(`Error embedding image for field ${field.name}`, e);
        }
      } else {
        pdfPage.drawText(String(val), {
          x,
          y: pHeight - (field.y * pHeight) - 12,
          size: 12,
          color: rgb(0, 0, 0),
        });
      }
    }

    const finalPdfBytes = await pdfDoc.save();
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${template.name.replace(/\s+/g, "_")}-filled.pdf"`,
    });
    res.send(Buffer.from(finalPdfBytes));

  } catch (err: any) {
    console.error("PDF Generate Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
