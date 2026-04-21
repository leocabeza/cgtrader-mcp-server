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

let cached: CachedToken | null = null;
let inFlight: Promise<CachedToken> | null = null;

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
  return { accessToken: data.access_token, refreshAt };
}

export async function getAccessToken(
  env: Env,
  forceRefresh = false,
): Promise<string> {
  if (
    !forceRefresh &&
    cached &&
    (cached.refreshAt === 0 || cached.refreshAt > Date.now())
  ) {
    return cached.accessToken;
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
}

export async function warmUpToken(env: Env): Promise<void> {
  await getAccessToken(env, true);
}
