import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { Env } from "./env.js";
import { warmUpToken } from "./services/token.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerModelTools } from "./tools/models.js";

export class CgTraderMCP extends McpAgent<Env> {
  server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  async init(): Promise<void> {
    await warmUpToken(this.env);
    registerModelTools(this.server, this.env);
    registerCategoryTools(this.server, this.env);
  }
}
