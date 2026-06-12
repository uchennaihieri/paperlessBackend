import { Router, Response } from "express";
import multer from "multer";
import * as xlsx from "xlsx";
import prisma from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/authenticate";

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// All endpoints require a valid session
router.use(authenticate as any);

// ── GET /api/v1/lists ─────────────────────────────────────────────────────────
// Get all reusable lists (metadata only)
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const lists = await prisma.reusableList.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        // intentionally omitting 'items' to keep payload small
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: lists });
  } catch (err) {
    console.error("Error fetching reusable lists:", err);
    res.status(500).json({ success: false, error: "Failed to fetch reusable lists.", code: "FAILED_TO_FETCH_REUSABLE_LISTS" });
  }
});

// ── GET /api/v1/lists/:id ──────────────────────────────────────────────────────
// Get a specific reusable list with items
router.get("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const list = await prisma.reusableList.findUnique({
      where: { id: req.params.id },
    });
    if (!list) {
      res.status(404).json({ success: false, error: "List not found", code: "LIST_NOT_FOUND" });
      return;
    }
    res.json({ success: true, data: list });
  } catch (err) {
    console.error("Error fetching reusable list:", err);
    res.status(500).json({ success: false, error: "Failed to fetch reusable list.", code: "FAILED_TO_FETCH_REUSABLE_LIST" });
  }
});

// ── POST /api/v1/lists/upload ─────────────────────────────────────────────────
// Upload Excel file and parse list
router.post("/upload", requireAdmin as any, upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const { name, description } = req.body;
    const file = req.file;

    if (!file) {
      res.status(400).json({ success: false, error: "No file uploaded.", code: "NO_FILE_UPLOADED" });
      return;
    }

    if (!name || name.trim() === "") {
      res.status(400).json({ success: false, error: "List name is required.", code: "LIST_NAME_IS_REQUIRED" });
      return;
    }

    // Parse the Excel file from buffer
    const workbook = xlsx.read(file.buffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];

    // Convert sheet to an array of arrays
    const jsonRows: any[][] = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    
    // Extract the first column items
    const items: string[] = [];
    for (const row of jsonRows) {
      if (row && row.length > 0 && row[0] !== undefined && row[0] !== null) {
        const val = String(row[0]).trim();
        if (val !== "") {
          items.push(val);
        }
      }
    }

    if (items.length === 0) {
      res.status(400).json({ success: false, error: "The uploaded file contains no valid items in the first column.", code: "THE_UPLOADED_FILE_CONTAINS_NO" });
      return;
    }

    const email = req.user?.email || "Unknown";

    const newList = await prisma.reusableList.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        items,
        createdBy: email,
      },
    });

    res.status(201).json({ success: true, data: newList });
  } catch (err: any) {
    console.error("Error uploading reusable list:", err);
    if (err?.code === "P2002") {
      res.status(409).json({ success: false, error: "A list with this name already exists.", code: "A_LIST_WITH_THIS_NAME_ALREADY" });
    } else {
      res.status(500).json({ success: false, error: "Failed to process the uploaded file.", code: "FAILED_TO_PROCESS_THE_UPLOADED" });
    }
  }
});

// ── DELETE /api/v1/lists/:id ──────────────────────────────────────────────────
router.delete("/:id", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.reusableList.delete({
      where: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting reusable list:", err);
    res.status(500).json({ success: false, error: "Failed to delete reusable list.", code: "FAILED_TO_DELETE_REUSABLE_LIST" });
  }
});

export default router;
