import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTokenMetadata,
  uploadImage,
  uploadMetadata,
  waitForMetadataAvailability,
} from "../src/launcher/pinata.js";

const originalFetch = globalThis.fetch;

function v3Response(cid: string): Response {
  return new Response(
    JSON.stringify({
      data: {
        id: "abc",
        cid,
        name: "f",
        size: 10,
        mime_type: "image/png",
        is_duplicate: false,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function metadataResponse(): Response {
  return new Response(JSON.stringify(sampleMeta), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const sampleMeta = buildTokenMetadata({
  name: "Doge",
  symbol: "DOGE",
  imageCid: "QmImg",
  tweet: { id: "t1", authorHandle: "elonmusk" },
});

describe("Pinata V3 uploads", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uploadImage hits V3 endpoint and returns the cid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(v3Response("QmFakeImageCid"));
    globalThis.fetch = fetchMock as never;
    const cid = await uploadImage(Buffer.from("fake"), "doge.png", "image/png", { jwt: "x" });
    expect(cid).toBe("QmFakeImageCid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://uploads.pinata.cloud/v3/files");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer x" });
  });

  it("uploadImage throws on 4xx with the body included", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { reason: "NO_SCOPES_FOUND" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ) as never;
    await expect(
      uploadImage(Buffer.from("fake"), "doge.png", "image/png", { jwt: "bad" }),
    ).rejects.toThrow(/403.*NO_SCOPES_FOUND/);
  });

  it("uploadMetadata uploads JSON-as-file and returns the cid", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(v3Response("QmFakeMetaCid")) as never;
    const cid = await uploadMetadata(sampleMeta, { jwt: "x" });
    expect(cid).toBe("QmFakeMetaCid");
  });

  it("waitForMetadataAvailability waits until gateway JSON is readable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(metadataResponse());
    globalThis.fetch = fetchMock as never;

    const url = await waitForMetadataAvailability("QmFakeMetaCid", sampleMeta, {
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    expect(url).toBe("https://gateway.pinata.cloud/ipfs/QmFakeMetaCid");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { accept: "application/json" },
      redirect: "manual",
    });
  });

  it("uploadMetadata rejects when ipfs:// uri exceeds 72 bytes", async () => {
    const oversize = "Q".repeat(80);
    globalThis.fetch = vi.fn().mockResolvedValue(v3Response(oversize)) as never;
    await expect(uploadMetadata(sampleMeta, { jwt: "x" })).rejects.toThrow(/72-byte/);
  });

  it("throws when response has no cid in data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as never;
    await expect(uploadImage(Buffer.from("x"), "x.png", "image/png", { jwt: "x" })).rejects.toThrow(
      /no cid/,
    );
  });
});

describe("buildTokenMetadata", () => {
  it("builds a flat pump.fun-style metadata with twitter link, no description", () => {
    const meta = buildTokenMetadata({
      name: "Elon Doge",
      symbol: "EDOGE",
      imageCid: "bafyImg",
      tweet: { id: "12345", authorHandle: "elonmusk" },
    });

    expect(meta).toEqual({
      name: "Elon Doge",
      symbol: "EDOGE",
      image: "ipfs://bafyImg",
      twitter: "https://x.com/elonmusk/status/12345",
      website: "https://x.com/elonmusk/status/12345",
      createdOn: "blank.build",
    });

    // Explicitly assert NO description / properties / attributes (memecoin-flat)
    expect((meta as Record<string, unknown>).description).toBeUndefined();
    expect((meta as Record<string, unknown>).properties).toBeUndefined();
    expect((meta as Record<string, unknown>).attributes).toBeUndefined();
  });
});
