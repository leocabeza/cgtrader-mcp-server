import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { getAccessToken, invalidateToken } from "./token.js";

const EDGE_CACHE_KEY = "https://cgtrader-mcp.internal/oauth-token";

const mockEnv: Env = {
  CGTRADER_CLIENT_ID: "test-id",
  CGTRADER_CLIENT_SECRET: "test-secret",
} as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  invalidateToken();
  await caches.default.delete(EDGE_CACHE_KEY);
  vi.restoreAllMocks();
});

describe("getAccessToken", () => {
  it("POSTs client_credentials to the default token URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ access_token: "abc", expires_in: 3600 }));

    const token = await getAccessToken(mockEnv);

    expect(token).toBe("abc");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://www.cgtrader.com/oauth/token");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("test-id");
    expect(body.get("client_secret")).toBe("test-secret");
  });

  it("serves the second call from the in-memory cache (no second fetch)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ access_token: "abc", expires_in: 3600 }));

    await getAccessToken(mockEnv);
    await getAccessToken(mockEnv);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when the token endpoint returns a non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );

    await expect(getAccessToken(mockEnv)).rejects.toThrow(
      /OAuth token exchange failed/,
    );
  });

  it("throws when client id/secret are missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(getAccessToken({} as Env)).rejects.toThrow(
      /CGTRADER_CLIENT_ID and CGTRADER_CLIENT_SECRET are required/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
