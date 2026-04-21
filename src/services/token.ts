import axios from "axios";
import {
  CLIENT_ID_ENV,
  CLIENT_SECRET_ENV,
  OAUTH_SCOPE_ENV,
  OAUTH_TIMEOUT_MS,
  OAUTH_TOKEN_URL_DEFAULT,
  OAUTH_TOKEN_URL_ENV,
  TOKEN_REFRESH_LEEWAY_S,
} from "../constants.js";

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

function readOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scope?: string;
} {
  const clientId = process.env[CLIENT_ID_ENV];
  const clientSecret = process.env[CLIENT_SECRET_ENV];
  if (!clientId || !clientSecret) {
    throw new Error(
      `${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV} env vars are required for OAuth client_credentials flow.`,
    );
  }
  return {
    clientId,
    clientSecret,
    tokenUrl: process.env[OAUTH_TOKEN_URL_ENV] ?? OAUTH_TOKEN_URL_DEFAULT,
    scope: process.env[OAUTH_SCOPE_ENV],
  };
}

async function fetchToken(): Promise<CachedToken> {
  const { clientId, clientSecret, tokenUrl, scope } = readOAuthConfig();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (scope) body.set("scope", scope);

  const res = await axios.post<TokenResponse>(tokenUrl, body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    timeout: OAUTH_TIMEOUT_MS,
  });

  const data = res.data;
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

export async function getAccessToken(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh &&
    cached &&
    (cached.refreshAt === 0 || cached.refreshAt > Date.now())
  ) {
    return cached.accessToken;
  }
  if (!inFlight) {
    inFlight = fetchToken().finally(() => {
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

/** For startup: force a token fetch to fail-fast on bad credentials. */
export async function warmUpToken(): Promise<void> {
  await getAccessToken(true);
}
