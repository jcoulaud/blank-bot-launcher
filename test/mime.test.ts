import { describe, expect, it } from "vitest";
import { mimeToExt } from "../src/util/mime.js";

describe("mimeToExt", () => {
  it("maps known image mime types", () => {
    expect(mimeToExt("image/png")).toBe("png");
    expect(mimeToExt("image/jpeg")).toBe("jpg");
    expect(mimeToExt("image/gif")).toBe("gif");
    expect(mimeToExt("image/webp")).toBe("webp");
  });

  it("falls back to 'bin' for unknown mime types", () => {
    expect(mimeToExt("image/avif")).toBe("bin");
    expect(mimeToExt("application/octet-stream")).toBe("bin");
    expect(mimeToExt("")).toBe("bin");
    expect(mimeToExt("not a mime")).toBe("bin");
  });

  it("treats mime matching as case-sensitive", () => {
    expect(mimeToExt("IMAGE/PNG")).toBe("bin");
  });
});
