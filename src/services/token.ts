import {
  OAUTH_TIMEOUT_MS,
  OAUTH_TOKEN_URL_DEFAULT,
  TOKEN_REFRESH_LEEWAY_S,
} from "../constants.js";
import type { Env } from "../env.js";

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface CachedToken {
  accessToken: string;
  // epoch ms when we should refetch; 0 means "unknown expiry, always valid"
  refreshAt: number;
}

const EDGE_CACHE_KEY = "https://cgtrader-mcp.internal/oauth-token";
const EDGE_CACHE_FALLBACK_TTL_S = 300;

let cached: CachedToken | null = null;
let inFlight: Promise<CachedToken> | null = null;

function stillValid(token: CachedToken): boolean {
  return token.refreshAt === 0 || token.refreshAt > Date.now();
}

async function readEdgeCache(): Promise<CachedToken | null> {
  const hit = await caches.default.match(EDGE_CACHE_KEY);
  if (!hit) return null;
  try {
    const data = (await hit.json()) as CachedToken;
    if (typeof data.accessToken !== "string") return null;
    if (!stillValid(data)) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeEdgeCache(
  token: CachedToken,
  expiresInSec: number,
): Promise<void> {
  const maxAge =
    expiresInSec > 0
      ? Math.max(1, expiresInSec - TOKEN_REFRESH_LEEWAY_S)
      : EDGE_CACHE_FALLBACK_TTL_S;
  await caches.default.put(
    EDGE_CACHE_KEY,
    new Response(JSON.stringify(token), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${maxAge}`,
      },
    }),
  );
}

async function fetchToken(env: Env): Promise<CachedToken> {
  const clientId = env.CGTRADER_CLIENT_ID;
  const clientSecret = env.CGTRADER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "CGTRADER_CLIENT_ID and CGTRADER_CLIENT_SECRET are required for OAuth client_credentials flow.",
    );
  }
  const tokenUrl = env.CGTRADER_OAUTH_TOKEN_URL ?? OAUTH_TOKEN_URL_DEFAULT;
  const scope = env.CGTRADER_OAUTH_SCOPE;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scope) body.set("scope", scope);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OAuth token exchange failed at ${tokenUrl} (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as TokenResponse;
  if (!data || typeof data.access_token !== "string") {
    throw new Error(
      `OAuth token endpoint at ${tokenUrl} did not return an access_token.`,
    );
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
  const refreshAt =
    expiresIn > 0 ? Date.now() + (expiresIn - TOKEN_REFRESH_LEEWAY_S) * 1000 : 0;
  const token: CachedToken = { accessToken: data.access_token, refreshAt };
  await writeEdgeCache(token, expiresIn);
  return token;
}

export async function getAccessToken(
  env: Env,
  forceRefresh = false,
): Promise<string> {
  if (!forceRefresh) {
    if (cached && stillValid(cached)) return cached.accessToken;
    const edge = await readEdgeCache();
    if (edge) {
      cached = edge;
      return edge.accessToken;
    }
  }
  if (!inFlight) {
    inFlight = fetchToken(env).finally(() => {
      inFlight = null;
    });
  }
  try {
    cached = await inFlight;
    return cached.accessToken;
  } catch (err) {
    cached = null;
    throw err;
  }
}

export function invalidateToken(): void {
  cached = null;
  caches.default.delete(EDGE_CACHE_KEY).catch(() => {});
}

export async function warmUpToken(env: Env): Promise<void> {
  await getAccessToken(env, true);
}
