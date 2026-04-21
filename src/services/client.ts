import { API_BASE_URL, REQUEST_TIMEOUT_MS } from "../constants.js";
import type { Env } from "../env.js";
import { getAccessToken, invalidateToken } from "./token.js";

const RESPONSE_CACHE_TTL_S = 60;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function buildUrl(
  path: string,
  params?: Record<string, unknown>,
  sortParams = false,
): URL {
  const base = API_BASE_URL.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${p}`);
  if (params) {
    const entries = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== null,
    );
    if (sortParams) entries.sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of entries) {
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(
  env: Env,
  path: string,
  params: Record<string, unknown> | undefined,
): Promise<Response> {
  const url = buildUrl(path, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const doFetch = async (forceRefresh: boolean): Promise<Response> => {
    const token = await getAccessToken(env, forceRefresh);
    return fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      redirect: "manual",
      signal: controller.signal,
    });
  };

  try {
    let res = await doFetch(false);
    if (res.status === 401) {
      invalidateToken();
      res = await doFetch(true);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureOk(res: Response, path: string): Promise<Response> {
  if (res.status < 400) return res;
  const body = await readBody(res);
  throw new ApiError(res.status, body, `CGTrader API ${res.status} at ${path}`);
}

export async function apiGet<T>(
  env: Env,
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const cacheKey = buildUrl(path, params, true).toString();
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    return (await hit.json()) as T;
  }
  const res = await ensureOk(await request(env, path, params), path);
  const text = await res.text();
  await caches.default.put(
    cacheKey,
    new Response(text, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${RESPONSE_CACHE_TTL_S}`,
      },
    }),
  );
  return JSON.parse(text) as T;
}

export async function apiGetRaw(
  env: Env,
  path: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  return ensureOk(await request(env, path, params), path);
}

export function handleApiError(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; message?: string } | null;
    const apiMsg = (body && (body.error || body.message)) || undefined;
    switch (error.status) {
      case 400:
        return `Error 400 (bad request): ${apiMsg ?? "Check your parameters."}`;
      case 401:
        return "Error 401 (unauthorized): Check CGTRADER_CLIENT_ID / CGTRADER_CLIENT_SECRET — the token exchange failed or the resulting token was rejected.";
      case 403:
        return `Error 403 (forbidden): ${apiMsg ?? "This resource is not accessible with the current OAuth app's permissions."}`;
      case 404:
        return `Error 404 (not found): ${apiMsg ?? "The requested resource does not exist."}`;
      case 429:
        return "Error 429 (rate limited): Wait before making further requests.";
      default:
        return `Error ${error.status}${apiMsg ? `: ${apiMsg}` : ""} while calling CGTrader API.`;
    }
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Error: Request to CGTrader timed out. Retry or reduce page size.";
    }
    return `Error: ${error.message}`;
  }
  return `Error: Unexpected failure: ${String(error)}`;
}
