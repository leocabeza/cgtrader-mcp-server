import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  UrlResolutionError,
  resolveModelId,
  resolveModelIdFromUrl,
} from "./url-resolver.js";

describe("resolveModelIdFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("short-circuits a /items/{id}/download-page URL without fetching", async () => {
    const id = await resolveModelIdFromUrl(
      "https://www.cgtrader.com/items/2226358/download-page",
    );
    expect(id).toBe(2226358);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("short-circuits a bare /items/{id} URL without fetching", async () => {
    const id = await resolveModelIdFromUrl(
      "https://www.cgtrader.com/items/42",
    );
    expect(id).toBe(42);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("rejects URLs from non-cgtrader hosts", async () => {
    await expect(
      resolveModelIdFromUrl("https://evil.example.com/items/1/download-page"),
    ).rejects.toBeInstanceOf(UrlResolutionError);
  });

  it("falls back to HTML scrape for product-page URLs", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        `<html><head><script type="application/ld+json">{"@type":"Product","sku":"999"}</script></head></html>`,
        { status: 200 },
      ),
    );
    const id = await resolveModelIdFromUrl(
      "https://www.cgtrader.com/free-3d-models/furniture/chair/some-slug",
    );
    expect(id).toBe(999);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("resolveModelId", () => {
  it("returns model_id when given", async () => {
    await expect(resolveModelId({ model_id: 7 })).resolves.toBe(7);
  });

  it("resolves from url when given", async () => {
    await expect(
      resolveModelId({ url: "https://www.cgtrader.com/items/2226358" }),
    ).resolves.toBe(2226358);
  });

  it("rejects when neither is provided", async () => {
    await expect(resolveModelId({})).rejects.toBeInstanceOf(
      UrlResolutionError,
    );
  });

  it("rejects when both are provided", async () => {
    await expect(
      resolveModelId({
        model_id: 7,
        url: "https://www.cgtrader.com/items/1",
      }),
    ).rejects.toBeInstanceOf(UrlResolutionError);
  });
});
