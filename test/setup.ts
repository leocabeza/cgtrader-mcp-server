// Minimal stub of the Cloudflare Workers `caches` global so tests can exercise
// modules that call `caches.default.match/put/delete`. For deeper Worker
// runtime coverage (DO lifecycle, real Cache API semantics), switch this test
// suite over to @cloudflare/vitest-pool-workers.

type CacheStore = Map<string, Response>;

function makeCache(): Cache {
  const store: CacheStore = new Map();
  return {
    async match(req: RequestInfo | URL) {
      const key = typeof req === "string" ? req : req.toString();
      const hit = store.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(req: RequestInfo | URL, res: Response) {
      const key = typeof req === "string" ? req : req.toString();
      store.set(key, res);
    },
    async delete(req: RequestInfo | URL) {
      const key = typeof req === "string" ? req : req.toString();
      return store.delete(key);
    },
  } as unknown as Cache;
}

(globalThis as unknown as { caches: CacheStorage }).caches = {
  default: makeCache(),
  async open() {
    return makeCache();
  },
} as unknown as CacheStorage;
