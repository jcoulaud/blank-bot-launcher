// Single source of truth for image mime/extension mapping.
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime] ?? "bin";
}
