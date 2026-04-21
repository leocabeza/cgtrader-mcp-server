#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import {
  CLIENT_ID_ENV,
  CLIENT_SECRET_ENV,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";
import { registerModelTools } from "./tools/models.js";
import { registerCategoryTools } from "./tools/categories.js";
import { warmUpToken } from "./services/token.js";

function buildServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerModelTools(server);
  registerCategoryTools(server);
  return server;
}

async function main(): Promise<void> {
  const missing = [CLIENT_ID_ENV, CLIENT_SECRET_ENV].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) {
    console.error(
      `ERROR: Missing required env vars: ${missing.join(", ")}. Register an OAuth app at https://www.cgtrader.com/oauth/applications/new and set both.`,
    );
    process.exit(1);
  }

  try {
    await warmUpToken();
    console.error("OAuth client_credentials token acquired successfully.");
  } catch (err) {
    console.error(
      `ERROR: OAuth token exchange failed at startup: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    // Stateless: a fresh server + transport per request avoids request-id collisions
    // and matches the SDK guidance for scalable HTTP deployments.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  app.listen(port, host, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${host}:${port}/mcp`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
