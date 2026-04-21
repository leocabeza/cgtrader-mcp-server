import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerCategoryTools(server, mockEnv);

  const client = new Client({ name: "test-client", version: "0.0.0" });
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
      categories: [
        { id: 1, name: "Vehicles", slug: "vehicles" },
        { id: 2, name: "Furniture", slug: "furniture", parent_id: 1 },
      ],
    });
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
