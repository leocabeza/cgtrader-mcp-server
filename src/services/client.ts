import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from "axios";
import { API_BASE_URL, REQUEST_TIMEOUT_MS } from "../constants.js";
import { getAccessToken, invalidateToken } from "./token.js";

let cachedClient: AxiosInstance | null = null;

function buildClient(): AxiosInstance {
  const instance = axios.create({
    baseURL: API_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { Accept: "application/json" },
    // Download redirect endpoint returns 3xx; we want to read Location ourselves.
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  instance.interceptors.request.use(async (config) => {
    const token = await getAccessToken();
    config.headers.set("Authorization", `Bearer ${token}`);
    return config;
  });
  return instance;
}

function client(): AxiosInstance {
  if (!cachedClient) cachedClient = buildClient();
  return cachedClient;
}

async function withAuthRetry<T extends AxiosResponse>(
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      invalidateToken();
      return await op();
    }
    throw err;
  }
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, unknown>,
  config?: AxiosRequestConfig,
): Promise<T> {
  const res = await withAuthRetry(() =>
    client().get<T>(path, { params, ...config }),
  );
  return res.data;
}

export async function apiGetRaw(
  path: string,
  params?: Record<string, unknown>,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse> {
  return withAuthRetry(() => client().get(path, { params, ...config }));
}

export function handleApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const e = error as AxiosError<{ error?: string; message?: string }>;
    if (e.response) {
      const status = e.response.status;
      const body = e.response.data;
      const apiMsg = (body && (body.error || body.message)) || undefined;
      switch (status) {
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
          return `Error ${status}${apiMsg ? `: ${apiMsg}` : ""} while calling CGTrader API.`;
      }
    }
    if (e.code === "ECONNABORTED") {
      return "Error: Request to CGTrader timed out. Retry or reduce page size.";
    }
    return `Error: Network failure calling CGTrader: ${e.message}`;
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: Unexpected failure: ${String(error)}`;
}
