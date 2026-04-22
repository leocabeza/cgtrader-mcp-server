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

import { apiGet, apiGetRaw } from "../services/client.js";
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
});

describe("cgtrader_search_models elicitation", () => {
  it("applies elicited refinements when the user accepts", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 1, models: [FREE_MODEL] });
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
    const params = vi.mocked(apiGet).mock.calls[0]![2] as Record<string, unknown>;
    expect(params.extensions).toBe("blend");
    expect(params.polygons).toBe("lt_5k");
    expect(params.sort).toBe("newest");
  });

  it("treats 'any' selections as no filter and keeps defaults", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
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

    const params = vi.mocked(apiGet).mock.calls[0]![2] as Record<string, unknown>;
    expect(params.extensions).toBeUndefined();
    expect(params.polygons).toBeUndefined();
    expect(params.sort).toBe("best_match");
  });

  it("runs with defaults when the user declines", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({ action: "decline" }),
    });

    const result = await client.callTool({
      name: "cgtrader_search_models",
      arguments: { keywords: "chair" },
    });

    expect(result.isError).toBeFalsy();
    const params = vi.mocked(apiGet).mock.calls[0]![2] as Record<string, unknown>;
    expect(params.extensions).toBeUndefined();
    expect(params.polygons).toBeUndefined();
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
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
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
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
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
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
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
    vi.mocked(apiGet).mockResolvedValueOnce({ total: 0, models: [] });
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
