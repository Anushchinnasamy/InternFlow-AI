import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";

export interface SavedUpload {
  storageUri: string;
  sha256: string;
}

export async function saveUploadedFile(
  internshipId: string,
  file: Express.Multer.File
): Promise<SavedUpload> {
  const safeOriginalName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
  return saveGeneratedFile(internshipId, file.buffer, safeOriginalName);
}

/**
 * Same storage convention as saveUploadedFile, but for buffers we generated
 * ourselves (e.g. server-rendered PDFs) rather than ones that arrived via
 * multer.
 */
export async function saveGeneratedFile(
  internshipId: string,
  buffer: Buffer,
  originalName: string
): Promise<SavedUpload> {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const safeOriginalName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${sha256}-${safeOriginalName}`;

  const dir = path.join(UPLOAD_DIR, internshipId);
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  await fs.writeFile(fullPath, buffer);

  const storageUri = path.join(UPLOAD_DIR, internshipId, filename).replace(/\\/g, "/");
  return { storageUri, sha256 };
}
