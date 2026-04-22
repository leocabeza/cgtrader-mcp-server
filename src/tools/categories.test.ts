import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod/v4";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

vi.mock("../services/client.js", () => ({
  apiGet: vi.fn(),
  apiGetRaw: vi.fn(),
  handleApiError: (e: unknown) => `Error: ${(e as Error).message ?? String(e)}`,
  ApiError: class ApiError extends Error {},
}));

import { apiGet } from "../services/client.js";
import { registerCategoryTools } from "./categories.js";

const mockEnv = {} as Env;

type ElicitResponder = (
  req: z.infer<typeof ElicitRequestSchema>,
) => Promise<unknown>;

async function connectedClient(opts?: {
  elicitation?: boolean;
  responder?: ElicitResponder;
}): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerCategoryTools(server, mockEnv);

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

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
});

describe("cgtrader_list_categories via MCP", () => {
  it("advertises the tool with its zod-derived input schema", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name);
    expect(names).toContain("cgtrader_list_categories");
    expect(names).toContain("cgtrader_get_category");

    const list = tools.find((t) => t.name === "cgtrader_list_categories")!;
    expect(list.inputSchema.properties).toHaveProperty("response_format");
  });

  it("returns markdown and structuredContent from a real callTool", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      categories: [
        { id: 1, name: "Vehicles", slug: "vehicles" },
        { id: 2, name: "Furniture", slug: "furniture", parent_id: 1 },
      ],
    });
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_list_categories",
      arguments: { response_format: "markdown" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("# CGTrader categories (2)");
    expect(content[0]?.text).toContain("Vehicles");
    expect(result.structuredContent).toEqual({
      count: 2,
      total: 2,
      category_id: null,
      _user_notes: null,
      categories: [
        { id: 1, name: "Vehicles", slug: "vehicles" },
        { id: 2, name: "Furniture", slug: "furniture", parent_id: 1 },
      ],
    });
  });

  it("narrows the returned list to the picked subtree when user drills in", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      categories: [
        { id: 1, name: "Vehicles" },
        { id: 10, name: "Cars", parent_id: 1 },
        { id: 11, name: "Sedan", parent_id: 10 },
        { id: 2, name: "Furniture" },
        { id: 20, name: "Chairs", parent_id: 2 },
      ],
    });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: { category: "2" },
      }),
    });

    const result = await client.callTool({
      name: "cgtrader_list_categories",
      arguments: {},
    });

    const structured = result.structuredContent as {
      count: number;
      total: number;
      category_id: number | null;
      categories: Array<{ id: number }>;
    };
    expect(structured.category_id).toBe(2);
    expect(structured.total).toBe(5);
    expect(structured.categories.map((c) => c.id).sort()).toEqual([2, 20]);
  });

  it("returns the full list when user picks 'Show me everything'", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      categories: [
        { id: 1, name: "Vehicles" },
        { id: 2, name: "Furniture" },
      ],
    });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: { category: "all" },
      }),
    });

    const result = await client.callTool({
      name: "cgtrader_list_categories",
      arguments: {},
    });

    const structured = result.structuredContent as {
      count: number;
      category_id: number | null;
    };
    expect(structured.category_id).toBeNull();
    expect(structured.count).toBe(2);
  });

  it("surfaces user notes and records them on structuredContent", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      categories: [
        { id: 1, name: "Vehicles" },
        { id: 2, name: "Furniture" },
      ],
    });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: {
          category: "all",
          notes: "actually I want subcategories of cars",
        },
      }),
    });

    const result = await client.callTool({
      name: "cgtrader_list_categories",
      arguments: {},
    });

    const content = result.content as Array<{ text: string }>;
    expect(content[0]?.text).toContain("User added a note");
    expect(content[0]?.text).toContain("subcategories of cars");
    expect(
      (result.structuredContent as { _user_notes: string | null })._user_notes,
    ).toBe("actually I want subcategories of cars");
  });

  it("appends a decline hint when the user declines the picker", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      categories: [
        { id: 1, name: "Vehicles" },
        { id: 2, name: "Furniture" },
      ],
    });
    const client = await connectedClient({
      elicitation: true,
      responder: async () => ({ action: "decline" }),
    });

    const result = await client.callTool({
      name: "cgtrader_list_categories",
      arguments: {},
    });

    const content = result.content as Array<{ text: string }>;
    expect(content[0]?.text).toContain("User declined the category picker");
  });

  it("skips the elicitation when fewer than 2 top-level categories exist", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      categories: [
        { id: 1, name: "Vehicles" },
        { id: 10, name: "Cars", parent_id: 1 },
      ],
    });
    const responder = vi.fn(async () => ({ action: "accept" }));
    const client = await connectedClient({ elicitation: true, responder });

    await client.callTool({
      name: "cgtrader_list_categories",
      arguments: {},
    });

    expect(responder).not.toHaveBeenCalled();
  });

  it("surfaces upstream errors as isError=true text content", async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error("boom"));
    const client = await connectedClient();

    const result = await client.callTool({
      name: "cgtrader_list_categories",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("boom");
  });
});
