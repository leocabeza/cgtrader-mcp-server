import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { elicitForm, hostSupportsElicitation, type FormSchema } from "./elicit.js";

const SCHEMA: FormSchema = {
  type: "object",
  properties: {
    color: {
      type: "string",
      title: "Color",
      oneOf: [
        { const: "red", title: "Red" },
        { const: "blue", title: "Blue" },
      ],
      default: "red",
    },
  },
};

async function connect(opts: {
  elicitation?: boolean;
  responder?: (req: unknown) => Promise<unknown>;
}): Promise<{ server: McpServer; client: Client }> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    opts.elicitation ? { capabilities: { elicitation: {} } } : undefined,
  );
  if (opts.responder) {
    client.setRequestHandler(
      ElicitRequestSchema,
      opts.responder as (req: unknown) => Promise<never>,
    );
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client };
}

describe("elicit helper", () => {
  it("skips when client did not advertise elicitation capability", async () => {
    const { server } = await connect({});
    expect(hostSupportsElicitation(server)).toBe(false);

    const outcome = await elicitForm(server, "pick one", SCHEMA);
    expect(outcome.status).toBe("skipped");
  });

  it("returns accepted with values when the host accepts", async () => {
    const { server } = await connect({
      elicitation: true,
      responder: async () => ({
        action: "accept",
        content: { color: "blue" },
      }),
    });
    expect(hostSupportsElicitation(server)).toBe(true);

    const outcome = await elicitForm<{ color: string }>(server, "pick one", SCHEMA);
    expect(outcome).toEqual({ status: "accepted", values: { color: "blue" } });
  });

  it("returns declined when the user explicitly declines", async () => {
    const { server } = await connect({
      elicitation: true,
      responder: async () => ({ action: "decline" }),
    });
    const outcome = await elicitForm(server, "pick one", SCHEMA);
    expect(outcome.status).toBe("declined");
  });

  it("returns skipped when the user cancels the dialog", async () => {
    const { server } = await connect({
      elicitation: true,
      responder: async () => ({ action: "cancel" }),
    });
    const outcome = await elicitForm(server, "pick one", SCHEMA);
    expect(outcome.status).toBe("skipped");
  });

  it("returns skipped when the request throws", async () => {
    const { server } = await connect({
      elicitation: true,
      responder: async () => {
        throw new Error("nope");
      },
    });
    const outcome = await elicitForm(server, "pick one", SCHEMA);
    expect(outcome.status).toBe("skipped");
  });
});
