import { Router } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import crypto from "crypto";

const router = Router();

// 1. Get all datasets accessible to the user
router.get("/", authenticate, async (req: AuthRequest, res: any) => {
  const userEmail = req.user?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: "Unauthorized" });

  try {
    const datasets = await prisma.uploadedDataset.findMany({
      where: {
        OR: [
          { uploadedBy: userEmail },
          { sharedWith: { has: userEmail } }
        ]
      },
      orderBy: { createdAt: "desc" }
    });
    
    // Get count of records for each dataset
    const datasetsWithCount = await Promise.all(datasets.map(async (ds) => {
      const count = await prisma.datasetRecord.count({ where: { datasetId: ds.id } });
      return { ...ds, totalRows: count };
    }));

    res.json({ success: true, data: datasetsWithCount });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Upload a new dataset
router.post("/", authenticate, async (req: AuthRequest, res: any) => {
  const userEmail = req.user?.email;
  if (!userEmail) return res.status(401).json({ success: false, error: "Unauthorized" });

  const { name, records, runFirstCentral, runCreditRegistry } = req.body;
  if (!name || !Array.isArray(records)) {
    return res.status(400).json({ success: false, error: "Name and records array are required" });
  }

  try {
    const dataset = await prisma.$transaction(async (tx) => {
      const ds = await tx.uploadedDataset.create({
        data: {
          name,
          uploadedBy: userEmail,
          status: "READY",
          runFirstCentral: !!runFirstCentral,
          runCreditRegistry: !!runCreditRegistry,
          sharedWith: []
        }
      });

      // Get max sequence to generate DAT1, DAT2...
      const maxRecord: any[] = await tx.$queryRaw`
        SELECT reference FROM "DatasetRecord" 
        WHERE reference ~ '^DAT[0-9]+$'
        ORDER BY CAST(SUBSTRING(reference FROM 4) AS INTEGER) DESC 
        LIMIT 1
      `;
      let nextId = 1;
      if (maxRecord && maxRecord.length > 0) {
        const lastRef = maxRecord[0].reference;
        nextId = parseInt(lastRef.replace('DAT', ''), 10) + 1;
      }

      // Insert records in bulk, generating unique DAT sequential references
      const toInsert = records.map((r, i) => {
        const ref = `DAT${nextId + i}`;

        return {
          datasetId: ds.id,
          reference: ref,
          bvn: r.BVN ? String(r.BVN) : null,
          rowData: r,
          processingStatus: (r.BVN && (runFirstCentral || runCreditRegistry)) ? "PENDING" : "SUCCESS"
        };
      });

      // Insert in chunks if too large, but createMany handles large arrays decently
      await tx.datasetRecord.createMany({
        data: toInsert
      });

      return ds;
    });

    res.json({ success: true, data: dataset });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Get detailed records for a dataset
router.get("/:id/records", authenticate, async (req: AuthRequest, res: any) => {
  const { id } = req.params;
  const userEmail = req.user?.email;
  
  try {
    const dataset = await prisma.uploadedDataset.findUnique({ where: { id } });
    if (!dataset) return res.status(404).json({ success: false, error: "Not found" });
    
    if (dataset.uploadedBy !== userEmail && !dataset.sharedWith.includes(userEmail || "")) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const records = await prisma.datasetRecord.findMany({
      where: { datasetId: id },
      orderBy: { id: "asc" }
    });
    
    res.json({ success: true, data: records, dataset });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Share dataset
router.post("/:id/share", authenticate, async (req: AuthRequest, res: any) => {
  const { id } = req.params;
  const { emails } = req.body;
  const userEmail = req.user?.email;

  if (!Array.isArray(emails)) {
    return res.status(400).json({ success: false, error: "Emails array is required" });
  }

  try {
    const dataset = await prisma.uploadedDataset.findUnique({ where: { id } });
    if (!dataset) return res.status(404).json({ success: false, error: "Not found" });
    if (dataset.uploadedBy !== userEmail && !dataset.sharedWith.includes(userEmail || "")) {
      return res.status(403).json({ success: false, error: "You do not have permission to share this dataset" });
    }

    // Merge existing shared users with new emails to prevent overwriting
    const updatedSharedWith = Array.from(new Set([...dataset.sharedWith, ...emails]));

    const updated = await prisma.uploadedDataset.update({
      where: { id },
      data: { sharedWith: updatedSharedWith }
    });

    res.json({ success: true, data: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Delete dataset
router.delete("/:id", authenticate, async (req: AuthRequest, res: any) => {
  const { id } = req.params;
  const userEmail = req.user?.email;

  try {
    const dataset = await prisma.uploadedDataset.findUnique({ where: { id } });
    if (!dataset) return res.status(404).json({ success: false, error: "Not found" });
    if (dataset.uploadedBy !== userEmail) {
      return res.status(403).json({ success: false, error: "Only the uploader can delete this dataset" });
    }

    await prisma.uploadedDataset.delete({ where: { id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Lookup by reference (Used by Form Filler)
router.get("/by-reference/:ref", authenticate, async (req: AuthRequest, res: any) => {
  const { ref } = req.params;
  try {
    const record = await prisma.datasetRecord.findUnique({
      where: { reference: ref }
    });

    if (!record) return res.status(404).json({ success: false, error: "Not found" });

    res.json({ success: true, data: record });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
