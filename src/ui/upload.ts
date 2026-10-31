import { ApiError } from "./api";

// A receipt photo on its way to the server. The platform refuses request bodies
// over 4.5 MB, so anything larger is re-encoded in the browser first. A JPEG or
// PNG that already fits goes untouched: the server blurs those two formats only,
// and a known sample keeps its fingerprint.

export const MAX_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const MAX_SIDE = 3000;
const QUALITIES = [0.85, 0.75, 0.6];
const SCALES = [1, 0.75, 0.55];

const encode = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", quality));

export async function prepareUpload(file: File): Promise<Blob> {
  if (file.size <= MAX_UPLOAD_BYTES && (file.type === "image/jpeg" || file.type === "image/png")) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ApiError(400, "bad_image", "This file could not be opened as a photo. Send a JPEG or PNG, or use the sample receipt.");
  }
  try {
    const fit = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    for (const scale of SCALES) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * fit * scale);
      canvas.height = Math.round(bitmap.height * fit * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const blob = await encode(canvas, quality);
        if (blob && blob.size <= MAX_UPLOAD_BYTES) return blob;
      }
    }
  } finally {
    bitmap.close();
  }
  throw new ApiError(413, "too_large", "This photo stays too large even after resizing. Crop it to the receipt, or use the sample receipt.");
}
