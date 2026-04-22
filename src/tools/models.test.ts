import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod/v4";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import type { CGTraderModel } from "../types.js";

type ElicitResponder = (
  req: z.infer<typeof ElicitRequestSchema>,
) => Promise<unknown>;

vi.mock("../services/client.js", () => ({
  apiGet: vi.fn(),
  apiGetRaw: vi.fn(),
  handleApiError: (e: unknown) =>
    `Error: ${(e as Error)?.message ?? String(e)}`,
  ApiError: class ApiError extends Error {},
}));

vi.mock("../services/url-resolver.js", async () => {
  class UrlResolutionError extends Error {
    constructor(m: string) {
      super(m);
      this.name = "UrlResolutionError";
    }
  }
  const resolveModelIdFromUrl = vi.fn();
  const resolveModelId = vi.fn(
    async (input: { model_id?: number; url?: string }) => {
      const gotId = input.model_id !== undefined;
      const gotUrl = input.url !== undefined;
      if (gotId === gotUrl) {
        throw new UrlResolutionError(
          "Provide exactly one of `model_id` or `url`.",
        );
      }
      return gotId ? input.model_id! : resolveModelIdFromUrl(input.url!);
    },
  );
  return {
    resolveModelIdFromUrl,
    resolveModelId,
    UrlResolutionError,
  };
});

import { apiGet, apiGetRaw } from "../services/client.js";
import { resolveModelIdFromUrl } from "../services/url-resolver.js";
import { registerModelTools } from "./models.js";

const mockEnv = {} as Env;

const FREE_MODEL: CGTraderModel = {
  id: 100,
  title: "Free Chair",
  author_name: "alice",
  prices: { download: 0 },
  files: [
    { id: 1, name: "chair.obj" },
    { id: 2, name: "chair.mtl" },
  ],
};

const PAID_MODEL: CGTraderModel = {
  id: 200,
  title: "Paid Chair",
  prices: { download: 9.99 },
  files: [{ id: 10, name: "chair.obj" }],
};

async function connectedClient(opts?: {
  elicitation?: boolean;
  responder?: ElicitResponder;
}): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerModelTools(server, mockEnv);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    opts?.elicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts?.responder) {
    client.setRequestHandler(
      ElicitRequestSchema,
      opts.responder as (req: unknown) => Promise<never>,
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function textOf(result: unknown): string {
  const items = ((result as { content?: unknown })?.content ?? []) as Array<{
    type: string;
    text: string;
  }>;
  return items[0]?.text ?? "";
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiGetRaw).mockReset();
  vi.mocked(resolveModelIdFromUrl).mockReset();
});

describe("cgtrader_search_models elicitation", () => {
  it("re-fetches with narrowed params when the user accepts the refinement", async () => {
    vi.mocked(apiGet)
      // First call: broad search returns a multi-page total (> per_page=25),
      // which triggers the post-search refinement elicit.
      .mockResolvedValueOnce({ total: 100, models: [FREE_MODEL] })
      // Second call: re-fetch with the narrowed params.
      .mockResolvedValueOnce({ total: 3, models: [FREE_MODEL] });
    const captured: unknown[] = [];
    const client = await connectedClient({
      elicitation: true,
      responder: async (req) => {
        captured.push(req);
        return {
          action: "accept",
          content: {
            format: "blend",
            complexity: "lt_5k",
            sort: "newest",
          },
        };
      },
    });

    await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(captured).toHaveLength(1);
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(2);
    const firstParams = vi.mocked(apiGet).mock.calls[0]![2] as Record<
      string,
      unknown
    >;
    expect(firstParams.extensions).toBeUndefined();
    expect(firstParams.polygons).toBeUndefined();
    const narrowedParams = vi.mocked(apiGet).mock.calls[1]![2] as Record<
      string,
      unknown
    >;
    expect(narrowedParams.extensions).toBe("blend");
    expect(narrowedParams.polygons).toBe("lt_5k");
    expect(narrowedParams.sort).toBe("newest");
  });

  it("treats 'any' selections as no filter and skips the re-fetch", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 100, models: [FREE_MODEL] });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: { format: "any", complexity: "any", sort: "best_match" },
      }),
    });

    await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    // No narrowing happened, so no second API call.
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1);
    const params = vi.mocked(apiGet).mock.calls[0]![2] as Record<string, unknown>;
    expect(params.extensions).toBeUndefined();
    expect(params.polygons).toBeUndefined();
    expect(params.sort).toBe("best_match");
  });

  it("runs with defaults when the user declines the refinement", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 100, models: [FREE_MODEL] });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({ action: "decline" }),
    });

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(result.isError).toBeFalsy();
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1);
    const params = vi.mocked(apiGet).mock.calls[0]![2] as Record<string, unknown>;
    expect(params.extensions).toBeUndefined();
    expect(params.polygons).toBeUndefined();
  });

  it("does NOT elicit when the result fits on a single page", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 5, models: [FREE_MODEL] });
    const responder = vi.fn(async () => ({ action: "accept", content: {} }));
    const client = await connectedClient({ elicitation: true, responder });

    await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(responder).not.toHaveBeenCalled();
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1);
  });

  it("does NOT elicit when the caller already supplied refinement params", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
    const responder = vi.fn(async () => ({ action: "accept", content: {} }));
    const client = await connectedClient({
      elicitation: true,
      responder,
    });

    await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair", low_poly: true },
    });

    expect(responder).not.toHaveBeenCalled();
  });

  it("does NOT elicit when the host lacks elicitation capability", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
    const client = await connectedClient(); // no capability declared

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(result.isError).toBeFalsy();
  });

  it("surfaces user-supplied notes as a hint in the result text", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 100, models: [FREE_MODEL] });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: {
          format: "any",
          complexity: "any",
          sort: "best_match",
          notes: "needs to open in Cinema 4D",
        },
      }),
    });

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(textOf(result)).toContain("User added a note");
    expect(textOf(result)).toContain("Cinema 4D");
  });

  it("ignores empty / whitespace-only notes", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 100, models: [FREE_MODEL] });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: { format: "any", complexity: "any", notes: "   " },
      }),
    });

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(textOf(result)).not.toContain("User added a note");
  });

  it("appends a decline hint when the user declines the refinement", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 100, models: [FREE_MODEL] });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({ action: "decline" }),
    });

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(textOf(result)).toContain("User declined the refinement prompt");
  });

  it("does NOT append a decline hint when the user cancels (vs. declines)", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 100, models: [FREE_MODEL] });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({ action: "cancel" }),
    });

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(textOf(result)).not.toContain("User declined");
  });
});

describe("cgtrader_search_models", () => {
  it("always sends min_price=0 and max_price=0 to the API", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      total: 1,
      models: [FREE_MODEL],
    });
    const client = await connectedClient();

    await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    const [, path, params] = vi.mocked(apiGet).mock.calls[0]!;
    expect(path).toBe("/models");
    expect((params as Record<string, unknown>).min_price).toBe(0);
    expect((params as Record<string, unknown>).max_price).toBe(0);
    expect((params as Record<string, unknown>).keywords).toBe("chair");
  });

  it("drops any paid model the API accidentally returns (defense in depth)", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      total: 2,
      models: [FREE_MODEL, PAID_MODEL],
    });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: {},
    });

    const structured = result.structuredContent as {
      count: number;
      models: CGTraderModel[];
    };
    expect(structured.count).toBe(1);
    expect(structured.models.map((m) => m.id)).toEqual([FREE_MODEL.id]);
  });
});

describe("cgtrader_get_model", () => {
  it("returns markdown + structured for a free model", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_model",
      arguments: { model_id: FREE_MODEL.id, response_format: "markdown" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Free Chair");
    expect((result.structuredContent as { id: number }).id).toBe(FREE_MODEL.id);
  });

  it("appends a next-action hint when the user picks one from the elicitation", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: { next: "images" },
      }),
    });

    const result = await client.callTool({
      name: "cgtrader_get_model",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("cgtrader_get_model_images");
    expect(
      (result.structuredContent as { _next_action: string | null })._next_action,
    ).toBe("images");
  });

  it("omits the hint when the user picks 'done'", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({ action: "accept", content: { next: "done" } }),
    });

    const result = await client.callTool({
      name: "cgtrader_get_model",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(textOf(result)).not.toContain("User requested next action");
    expect(
      (result.structuredContent as { _next_action: string | null })._next_action,
    ).toBeNull();
  });

  it("surfaces user notes from the follow-up form", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: { next: "done", notes: "convert to STL for printing" },
      }),
    });

    const result = await client.callTool({
      name: "cgtrader_get_model",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(textOf(result)).toContain("User added a note");
    expect(textOf(result)).toContain("STL for printing");
    expect(
      (result.structuredContent as { _user_notes: string | null })._user_notes,
    ).toBe("convert to STL for printing");
  });

  it("appends a decline hint when the user declines the follow-up", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({ action: "decline" }),
    });

    const result = await client.callTool({
      name: "cgtrader_get_model",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(textOf(result)).toContain("User declined the refinement prompt");
  });

  it("rejects a paid model with a FreeOnlyViolation error", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PAID_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_model",
      arguments: { model_id: PAID_MODEL.id },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not free/);
  });
});

describe("cgtrader_get_model_images", () => {
  it("returns images for a free model", async () => {
    vi.mocked(apiGet)
      .mockResolvedValueOnce({ model: FREE_MODEL })
      .mockResolvedValueOnce({
        images: [
          { id: 1, url: "https://img/1.jpg" },
          { id: 2, url: "https://img/2.jpg" },
        ],
      });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_model_images",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { count: number }).count).toBe(2);
  });

  it("rejects a paid model and never fetches the images endpoint", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PAID_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_model_images",
      arguments: { model_id: PAID_MODEL.id },
    });

    expect(result.isError).toBe(true);
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1); // only the guard call
  });
});

describe("cgtrader_get_model_license", () => {
  it("returns license info for a free model", async () => {
    vi.mocked(apiGet)
      .mockResolvedValueOnce({ model: FREE_MODEL })
      .mockResolvedValueOnce({
        name: "Royalty Free",
        description: "Use freely.",
      });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_model_license",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Royalty Free");
  });

  it("rejects a paid model and never fetches the license endpoint", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PAID_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_model_license",
      arguments: { model_id: PAID_MODEL.id },
    });

    expect(result.isError).toBe(true);
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1);
  });
});

describe("cgtrader_download_free_file", () => {
  it("returns a signed URL for a valid file on a free model", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    vi.mocked(apiGetRaw).mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { location: "https://s3.example.com/signed" },
      }),
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_download_free_file",
      arguments: { model_id: FREE_MODEL.id, file_id: 1 },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("https://s3.example.com/signed");
    expect(
      (result.structuredContent as { download_url: string }).download_url,
    ).toBe("https://s3.example.com/signed");
  });

  it("rejects a file_id that doesn't belong to the model", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_download_free_file",
      arguments: { model_id: FREE_MODEL.id, file_id: 9999 },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not belong/);
    expect(vi.mocked(apiGetRaw)).not.toHaveBeenCalled();
  });

  it("rejects a paid model without hitting the redirect endpoint", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PAID_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_download_free_file",
      arguments: { model_id: PAID_MODEL.id, file_id: 10 },
    });

    expect(result.isError).toBe(true);
    expect(vi.mocked(apiGetRaw)).not.toHaveBeenCalled();
  });
});

describe("cgtrader_get_free_model_download_urls", () => {
  it("resolves URLs for every file on a free model", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    vi.mocked(apiGetRaw).mockImplementation(async (_env, path) => {
      const fileId = path.split("/").pop();
      return new Response(null, {
        status: 200,
        headers: { location: `https://s3.example.com/${fileId}` },
      });
    });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_free_model_download_urls",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      count: number;
      files: Array<{ file_id: number; download_url: string | null }>;
    };
    expect(structured.count).toBe(2);
    expect(structured.files.map((f) => f.download_url).sort()).toEqual([
      "https://s3.example.com/1",
      "https://s3.example.com/2",
    ]);
  });

  it("reports per-file failures without failing the whole call", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: FREE_MODEL });
    vi.mocked(apiGetRaw).mockImplementation(async (_env, path) => {
      if (path.endsWith("/1")) {
        return new Response(null, {
          status: 200,
          headers: { location: "https://s3.example.com/1" },
        });
      }
      throw new Error("upstream 500");
    });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_free_model_download_urls",
      arguments: { model_id: FREE_MODEL.id },
    });

    expect(result.isError).toBeFalsy();
    const files = (
      result.structuredContent as {
        files: Array<{
          file_id: number;
          download_url: string | null;
          error: string | null;
        }>;
      }
    ).files;
    expect(files.find((f) => f.file_id === 1)?.download_url).toBe(
      "https://s3.example.com/1",
    );
    expect(files.find((f) => f.file_id === 2)?.error).toContain("upstream 500");
  });

  it("rejects a paid model without calling the redirect endpoint", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PAID_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_get_free_model_download_urls",
      arguments: { model_id: PAID_MODEL.id },
    });

    expect(result.isError).toBe(true);
    expect(vi.mocked(apiGetRaw)).not.toHaveBeenCalled();
  });
});

describe("cgtrader_preview_model_3d", () => {
  const PREVIEW_MODEL: CGTraderModel = {
    id: 300,
    title: "Previewable Chair",
    prices: { download: 0 },
    files: [
      { id: 41, name: "chair.blend" },
      { id: 42, name: "chair.obj" },
      { id: 43, name: "chair.glb" },
      { id: 44, name: "chair.fbx" },
    ],
  };

  type PreviewStructured = {
    model_id: number;
    model_title?: string;
    picked: {
      file_id: number;
      extension: string;
      download_url: string;
      name?: string;
    } | null;
    candidates: Array<{ file_id: number; extension: string }>;
    unsupported_extensions: string[];
  };

  it("picks glb when available and resolves the signed URL", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PREVIEW_MODEL });
    vi.mocked(apiGetRaw).mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { location: "https://s3.example.com/chair.glb" },
      }),
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_preview_model_3d",
      arguments: { model_id: PREVIEW_MODEL.id },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as PreviewStructured;
    expect(s.picked?.file_id).toBe(43); // chair.glb
    expect(s.picked?.extension).toBe("glb");
    expect(s.picked?.download_url).toBe("https://s3.example.com/chair.glb");
    // Candidates are ordered by preference (glb > fbx > obj > stl > gltf).
    expect(s.candidates.map((c) => c.extension)).toEqual(["glb", "fbx", "obj"]);
    expect(s.unsupported_extensions).toEqual(["blend"]);
    // Only the picked file's redirect was fetched — we don't pre-resolve
    // signed URLs for non-picked candidates.
    expect(vi.mocked(apiGetRaw)).toHaveBeenCalledTimes(1);
  });

  it("resolves a URL to a model id before fetching the model", async () => {
    vi.mocked(resolveModelIdFromUrl).mockResolvedValueOnce(PREVIEW_MODEL.id);
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PREVIEW_MODEL });
    vi.mocked(apiGetRaw).mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { location: "https://s3.example.com/chair.glb" },
      }),
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_preview_model_3d",
      arguments: {
        url: "https://www.cgtrader.com/free-3d-models/furniture/chair",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(vi.mocked(resolveModelIdFromUrl)).toHaveBeenCalledWith(
      "https://www.cgtrader.com/free-3d-models/furniture/chair",
    );
    const s = result.structuredContent as PreviewStructured;
    expect(s.model_id).toBe(PREVIEW_MODEL.id);
  });

  it("returns picked=null when no web-viewable file exists", async () => {
    const BLEND_ONLY_MODEL: CGTraderModel = {
      id: 301,
      title: "Blend Only",
      prices: { download: 0 },
      files: [
        { id: 51, name: "scene.blend" },
        { id: 52, name: "scene.max" },
      ],
    };
    vi.mocked(apiGet).mockResolvedValueOnce({ model: BLEND_ONLY_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_preview_model_3d",
      arguments: { model_id: BLEND_ONLY_MODEL.id },
    });

    expect(result.isError).toBeFalsy();
    const s = result.structuredContent as PreviewStructured;
    expect(s.picked).toBeNull();
    expect(s.candidates).toEqual([]);
    expect(s.unsupported_extensions.sort()).toEqual(["blend", "max"]);
    // No signed-URL resolution should have happened.
    expect(vi.mocked(apiGetRaw)).not.toHaveBeenCalled();
  });

  it("rejects a paid model before resolving any URLs", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ model: PAID_MODEL });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_preview_model_3d",
      arguments: { model_id: PAID_MODEL.id },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not free/);
    expect(vi.mocked(apiGetRaw)).not.toHaveBeenCalled();
  });

  it("surfaces URL-resolution failures as a clean error", async () => {
    vi.mocked(resolveModelIdFromUrl).mockRejectedValueOnce(
      new (
        await import("../services/url-resolver.js")
      ).UrlResolutionError("Could not locate a model id in https://…"),
    );
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_preview_model_3d",
      arguments: { url: "https://www.cgtrader.com/free-3d-models/unknown" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Could not locate a model id/);
    expect(vi.mocked(apiGet)).not.toHaveBeenCalled();
  });

  it("rejects input that supplies both model_id and url", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "cgtrader_preview_model_3d",
      arguments: {
        model_id: 300,
        url: "https://www.cgtrader.com/free-3d-models/furniture/chair",
      },
    });
    // Zod rejection surfaces as an error response, not a thrown exception.
    expect(result.isError).toBe(true);
    expect(vi.mocked(apiGet)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveModelIdFromUrl)).not.toHaveBeenCalled();
  });

  it("rejects input that supplies neither model_id nor url", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "cgtrader_preview_model_3d",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(vi.mocked(apiGet)).not.toHaveBeenCalled();
  });
});
