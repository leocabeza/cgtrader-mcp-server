import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { AuthProps, Env } from "./env.js";
import { warmUpToken } from "./services/token.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerModelTools } from "./tools/models.js";

export class CgTraderMCP extends McpAgent<Env, unknown, AuthProps> {
  server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  async init(): Promise<void> {
    // Tools register unconditionally. Throwing here would abort the DO's
    // init() and leave the MCP session with an empty tool list — bad creds
    // would silently hide every tool instead of surfacing a real error.
    registerModelTools(this.server, this.env);
    registerCategoryTools(this.server, this.env);
    // Opportunistic: warm the CGTrader token cache so the first tool call
    // doesn't pay the token-exchange latency. Any failure (bad creds, DNS,
    // rotated secret) surfaces on the first actual tool call, where the
    // error message is visible to the caller.
    try {
      await warmUpToken(this.env);
    } catch (err) {
      console.warn(
        "[cgtrader-mcp] warmUpToken failed; tools still registered:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
