import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  CGTRADER_CLIENT_ID: string;
  CGTRADER_CLIENT_SECRET: string;
  CGTRADER_OAUTH_TOKEN_URL?: string;
  CGTRADER_OAUTH_SCOPE?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAIL_DOMAIN?: string;
}

export interface AuthProps extends Record<string, unknown> {
  email: string;
  sub: string;
  name?: string;
}
