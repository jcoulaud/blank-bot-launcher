// X-owned image CDN hosts. Used by both the stream parser (which filters
// out media URLs we won't fetch) and the image downloader (which enforces
// the allowlist before connecting). Keep both call sites on the same set.
export const ALLOWED_IMAGE_HOSTS = new Set(["pbs.twimg.com", "video.twimg.com", "media.x.com"]);
