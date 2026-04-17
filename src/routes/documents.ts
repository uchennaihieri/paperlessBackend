import { Router, Request, Response } from "express";
import { PDFDocument, rgb } from "pdf-lib";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { downloadFromSharePoint } from "../lib/sharepoint";

const router = Router();
router.use(authenticate as any);

// POST /api/v1/documents/generate
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
    
    // Fetch PDF from SharePoint proxy
    const { buffer: pdfBuffer } = await downloadFromSharePoint(template.sharepointPath);
    
    // Load PDF
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();

    for (const field of template.fields) {
      const val = data[field.name];
      if (!val) continue; // Skip if no data provided
      
      const pageIndex = field.page ?? 0;
      if (pageIndex >= pages.length || pageIndex < 0) continue;
      
      const pdfPage = pages[pageIndex];
      const { width: pWidth, height: pHeight } = pdfPage.getSize();
      
      const x = field.x * pWidth;
      // Front-end UI is usually coordinates from top-left, pdf-lib is bottom-left origin
      const y = (1 - field.y - field.height) * pHeight; 
      const fWidth = field.width * pWidth;
      const fHeight = field.height * pHeight;
      
      if (field.type === "image" || field.type === "signature") {
        let imageBytes: Buffer;
        let image;
        
        try {
          if (val.startsWith("data:image/jpeg") || val.startsWith("data:image/jpg")) {
            imageBytes = Buffer.from(val.split(',')[1], 'base64');
            image = await pdfDoc.embedJpg(imageBytes);
          } else if (val.startsWith("data:image/png") || val.startsWith("data:image/")) {
            imageBytes = Buffer.from(val.split(',')[1], 'base64');
            image = await pdfDoc.embedPng(imageBytes);
          } else {
            // Assume raw base64 png
            imageBytes = Buffer.from(val, 'base64');
            image = await pdfDoc.embedPng(imageBytes).catch(() => pdfDoc.embedJpg(imageBytes));
          }
          
          if (image) {
            pdfPage.drawImage(image, {
              x,
              y,
              width: fWidth,
              height: fHeight,
            });
          }
        } catch(e) {
             console.error(`Error embedding image for field ${field.name}`, e);
        }
      } else {
         // Text field
         pdfPage.drawText(String(val), {
           x,
           y: pHeight - (field.y * pHeight) - 12, // approx baseline for top-left
           size: 12,
           color: rgb(0, 0, 0),
         });
      }
    }
    
    const finalPdfBytes = await pdfDoc.save();
    
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${template.name.replace(/\s+/g, '_')}-filled.pdf"`,
    });
    
    // Return the generated PDF
    res.send(Buffer.from(finalPdfBytes));
    
  } catch (err: any) {
    console.error("PDF Generate Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
