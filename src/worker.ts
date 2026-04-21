import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { GoogleHandler } from "./auth/google-handler.js";
import { CgTraderMCP } from "./mcp-agent.js";

export { CgTraderMCP };

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: CgTraderMCP.serve("/mcp") as never,
  defaultHandler: GoogleHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["openid", "email", "profile"],
});
