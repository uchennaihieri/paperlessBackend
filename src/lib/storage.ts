import fs from "fs/promises";
import path from "path";
import prisma from "./prisma";
import crypto from "crypto";

/**
 * Stores a document locally and enqueues it for SharePoint sync.
 * This function intercepts what used to be direct SharePoint uploads.
 * 
 * @param buffer The file buffer
 * @param originalFilename The original file name
 * @param mimeType The file mime type
 * @param targetFolder The target folder structure (e.g. "FormName/REF123")
 * @returns The relative local path saved
 */
export async function storeDocumentLocally(
  buffer: Buffer,
  originalFilename: string,
  mimeType: string,
  targetFolder: string,
  preserveFilename: boolean = false
): Promise<string> {
  const baseDir = process.env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), "uploads");
  
  // If targetFolder is explicitly empty, we assume originalFilename is already a full relative path
  // that the caller wants to overwrite/use exactly as is.
  const isExactPath = targetFolder === "";
  
  const spFolder = process.env.SHAREPOINT_UPLOAD_FOLDER || "uploads";
  
  let relativePath: string;
  let absolutePath: string;
  let uniqueFilename: string;

  if (isExactPath) {
    relativePath = originalFilename;
    absolutePath = path.join(baseDir, relativePath);
    targetFolder = path.dirname(relativePath).replace(/\\/g, "/");
    if (targetFolder === ".") targetFolder = "";
    uniqueFilename = path.basename(relativePath);
  } else {
    const safeFilename = originalFilename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    uniqueFilename = preserveFilename 
      ? safeFilename 
      : `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeFilename}`;
    relativePath = path.join(targetFolder, uniqueFilename).replace(/\\/g, "/");
    absolutePath = path.join(baseDir, relativePath);
  }

  // Ensure the directory exists
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  // Save the file locally
  await fs.writeFile(absolutePath, buffer);

  // Add job to sync queue
  await prisma.sharepointSyncQueue.create({
    data: {
      localPath: absolutePath,
      targetFolder: targetFolder,
      mimeType: mimeType,
      filename: uniqueFilename,
      status: "Pending"
    }
  });

  return relativePath;
}
