import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { Env } from "./env.js";
import { CgTraderMCP } from "./mcp-agent.js";

export { CgTraderMCP };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
      });
    }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return CgTraderMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(
        request,
        env,
        ctx,
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
