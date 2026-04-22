import { REQUEST_TIMEOUT_MS } from "../constants.js";

export class UrlResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlResolutionError";
  }
}

const ALLOWED_HOSTS = new Set(["www.cgtrader.com", "cgtrader.com"]);

// Matches the <script type="application/ld+json">…</script> block (single-line
// or multi-line). CGTrader's product pages ship exactly one JSON-LD Product
// block whose `sku` is the numeric model id — schema.org's canonical product
// identifier slot, stable across redesigns.
const LD_JSON_RE = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;

// Fallback: every image URL on a product page uses the pattern
// https://img-new.cgtrader.com/items/<model-id>/…, and the hero model's
// images are emitted first in the HTML. Used only if JSON-LD parsing fails.
const ITEMS_ID_RE = /img-new\.cgtrader\.com\/items\/(\d+)\//;

// `/items/{id}` (with optional trailing segments like `/download-page`) carries
// the model id directly in the path — no HTML fetch needed.
const ITEMS_PATH_RE = /^\/items\/(\d+)(?:\/|$)/;

/**
 * Resolves a CGTrader product page URL to its numeric model id.
 *
 * Only accepts www.cgtrader.com / cgtrader.com URLs (defensive: keeps this
 * helper from becoming an SSRF oracle if a caller feeds it untrusted input).
 */
export async function resolveModelIdFromUrl(rawUrl: string): Promise<number> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlResolutionError(`Not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UrlResolutionError(
      `URL must be http(s); got ${parsed.protocol}`,
    );
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new UrlResolutionError(
      `URL host must be cgtrader.com; got ${parsed.hostname}`,
    );
  }

  const pathMatch = parsed.pathname.match(ITEMS_PATH_RE);
  if (pathMatch) {
    const id = Number.parseInt(pathMatch[1]!, 10);
    if (Number.isFinite(id) && id > 0) return id;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        // Some CDNs treat requests without a UA as bots and 403; a stock UA
        // keeps the public product page accessible.
        "User-Agent": "Mozilla/5.0 (compatible; cgtrader-mcp/0.1)",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new UrlResolutionError(
        `Fetching ${parsed.toString()} returned ${res.status}`,
      );
    }
    html = await res.text();
  } catch (err) {
    if (err instanceof UrlResolutionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new UrlResolutionError(
        `Timed out fetching ${parsed.toString()}`,
      );
    }
    throw new UrlResolutionError(
      `Failed to fetch ${parsed.toString()}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const ldMatch = html.match(LD_JSON_RE);
  if (ldMatch) {
    try {
      const parsedLd = JSON.parse(ldMatch[1]!) as unknown;
      const sku = extractSku(parsedLd);
      if (sku !== null) return sku;
    } catch {
      // Malformed JSON-LD — fall through to regex fallback.
    }
  }

  const itemsMatch = html.match(ITEMS_ID_RE);
  if (itemsMatch) {
    const id = Number.parseInt(itemsMatch[1]!, 10);
    if (Number.isFinite(id) && id > 0) return id;
  }

  throw new UrlResolutionError(
    `Could not locate a model id in ${parsed.toString()} — page structure may have changed.`,
  );
}

/**
 * Resolves a model id from a `{ model_id?, url? }` input, enforcing that
 * exactly one is provided. Shared by every tool that accepts either form.
 */
export async function resolveModelId(input: {
  model_id?: number;
  url?: string;
}): Promise<number> {
  const gotId = input.model_id !== undefined;
  const gotUrl = input.url !== undefined;
  if (gotId === gotUrl) {
    throw new UrlResolutionError(
      "Provide exactly one of `model_id` or `url`.",
    );
  }
  return gotId ? input.model_id! : resolveModelIdFromUrl(input.url!);
}

function extractSku(ld: unknown): number | null {
  if (!ld || typeof ld !== "object") return null;
  // JSON-LD can be a single node or an array of nodes.
  if (Array.isArray(ld)) {
    for (const entry of ld) {
      const n = extractSku(entry);
      if (n !== null) return n;
    }
    return null;
  }
  const obj = ld as Record<string, unknown>;
  const type = obj["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
    const sku = obj.sku;
    if (typeof sku === "number" && Number.isFinite(sku) && sku > 0) return sku;
    if (typeof sku === "string") {
      const n = Number.parseInt(sku, 10);
      if (Number.isFinite(n) && n > 0 && String(n) === sku.trim()) return n;
    }
  }
  return null;
}
