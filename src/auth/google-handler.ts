import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { SERVER_NAME, SERVER_VERSION } from "../constants.js";
import type { Env } from "../env.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GoogleIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
}

function base64UrlEncode(input: string): string {
  return btoa(input)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function encodeState(req: AuthRequest): string {
  return base64UrlEncode(JSON.stringify(req));
}

function decodeState(state: string): AuthRequest {
  return JSON.parse(base64UrlDecode(state)) as AuthRequest;
}

function decodeJwtPayload(jwt: string): GoogleIdTokenClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  return JSON.parse(base64UrlDecode(parts[1])) as GoogleIdTokenClaims;
}

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/oauth-callback`;
}

function html(title: string, body: string, status = 200): Response {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:4rem auto;padding:0 1rem;color:#222;line-height:1.5}h1{font-size:1.25rem}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:.2rem}</style></head><body><h1>${title}</h1>${body}</body></html>`;
  return new Response(page, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export const GoogleHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
      });
    }

    if (url.pathname === "/authorize") {
      const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const google = new URL(GOOGLE_AUTH_URL);
      google.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      google.searchParams.set("redirect_uri", callbackUrl(request));
      google.searchParams.set("scope", "openid email profile");
      google.searchParams.set("response_type", "code");
      google.searchParams.set("access_type", "online");
      google.searchParams.set("prompt", "select_account");
      google.searchParams.set("state", encodeState(oauthReq));
      if (env.ALLOWED_EMAIL_DOMAIN) {
        google.searchParams.set("hd", env.ALLOWED_EMAIL_DOMAIN);
      }
      return Response.redirect(google.toString(), 302);
    }

    if (url.pathname === "/oauth-callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const googleErr = url.searchParams.get("error");
      if (googleErr) {
        return html(
          "Sign-in failed",
          `<p>Google returned an error: <code>${googleErr}</code>.</p>`,
          400,
        );
      }
      if (!code || !state) {
        return html(
          "Sign-in failed",
          "<p>Missing <code>code</code> or <code>state</code> from Google.</p>",
          400,
        );
      }

      let oauthReq: AuthRequest;
      try {
        oauthReq = decodeState(state);
      } catch {
        return html("Sign-in failed", "<p>Invalid state.</p>", 400);
      }

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          grant_type: "authorization_code",
          redirect_uri: callbackUrl(request),
        }),
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => "");
        return html(
          "Sign-in failed",
          `<p>Google token exchange returned ${tokenRes.status}.</p><pre>${body.slice(0, 500)}</pre>`,
          502,
        );
      }
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) {
        return html(
          "Sign-in failed",
          "<p>Google did not return an <code>id_token</code>.</p>",
          502,
        );
      }

      let claims: GoogleIdTokenClaims;
      try {
        claims = decodeJwtPayload(tokens.id_token);
      } catch {
        return html("Sign-in failed", "<p>Could not decode Google id_token.</p>", 502);
      }

      const allowed = env.ALLOWED_EMAIL_DOMAIN;
      const email = claims.email?.toLowerCase();
      if (allowed) {
        const hdOk = claims.hd === allowed;
        const emailOk = !!email && email.endsWith(`@${allowed.toLowerCase()}`);
        if (!hdOk && !emailOk) {
          return html(
            "Access denied",
            `<p>This server only accepts <code>@${allowed}</code> accounts.</p>`,
            403,
          );
        }
      }
      if (!email || claims.email_verified === false) {
        return html(
          "Access denied",
          "<p>Google account has no verified email.</p>",
          403,
        );
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReq,
        userId: claims.sub,
        scope: oauthReq.scope,
        metadata: {},
        props: { email, sub: claims.sub, name: claims.name },
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response("Not found", { status: 404 });
  },
};
