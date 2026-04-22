# cgtrader-mcp-server

TypeScript MCP server exposing CGTrader's marketplace (free models only) over Streamable HTTP.

## CGTrader API authentication

This project authenticates to the CGTrader API (`https://api.cgtrader.com/v1/*`) using **OAuth 2.0 `client_credentials`**, even though the public API docs at <https://api.cgtrader.com/docs/index.html> describe authentication in terms of "API keys." The `/oauth/applications/new` URL pattern on cgtrader.com is a standard Rails/Doorkeeper OAuth 2 provider, and that is what this server uses at runtime.

### Flow

1. **Register an OAuth application** at <https://www.cgtrader.com/oauth/applications/new> (confidential/trusted; redirect URI is required by the form but unused by `client_credentials`). Copy the issued `client_id` and `client_secret`.
2. At **startup**, `src/index.ts:38` calls `warmUpToken()` (`src/services/token.ts:105`) which forces an OAuth token exchange so bad credentials fail fast before the HTTP listener starts.
3. **Token exchange** (`fetchToken`, `src/services/token.ts:49`) — `POST` to the token endpoint with `Content-Type: application/x-www-form-urlencoded` and body:
   ```
   grant_type=client_credentials
   client_id=<CGTRADER_CLIENT_ID>
   client_secret=<CGTRADER_CLIENT_SECRET>
   scope=<CGTRADER_OAUTH_SCOPE>   # only if set
   ```
   Default token URL is `https://www.cgtrader.com/oauth/token` (`src/constants.ts:2`), overridable via `CGTRADER_OAUTH_TOKEN_URL`.
4. **Caching** (`src/services/token.ts:78`) — the `access_token` is cached in module-scope memory. If the response includes `expires_in`, the token is refreshed `TOKEN_REFRESH_LEEWAY_S` (60s) before expiry (`src/constants.ts:9`); if no expiry is returned, the token is treated as always valid until a 401 invalidates it. Concurrent callers share a single in-flight fetch via the `inFlight` promise to avoid a thundering herd.
5. **Per-request authorization** — the axios instance in `src/services/client.ts:21` installs a request interceptor that calls `getAccessToken()` and sets `Authorization: Bearer <token>` on every outbound call to `api.cgtrader.com/v1/*`.
6. **401 recovery** (`withAuthRetry`, `src/services/client.ts:34`) — if any API call returns 401, the cached token is invalidated via `invalidateToken()` and the request is retried exactly once with a freshly-minted token. A second 401 surfaces to the caller.

### Environment variables (auth-related)

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CGTRADER_CLIENT_ID` | yes | — | OAuth app client id. Missing ⇒ process exits at `src/index.ts:30`. |
| `CGTRADER_CLIENT_SECRET` | yes | — | OAuth app client secret. |
| `CGTRADER_OAUTH_TOKEN_URL` | no | `https://www.cgtrader.com/oauth/token` | Override the token endpoint. |
| `CGTRADER_OAUTH_SCOPE` | no | unset | Optional `scope` sent in the token request. |

### What this project does **not** do

- **No end-user OAuth.** There is no `authorization_code` flow, no redirect handler, no per-user tokens — the server acts on behalf of the registered OAuth app only. This is why the server is scoped to free-models-only: a confidential client has no user context to charge.
- **No refresh tokens.** `client_credentials` re-mints access tokens by re-exchanging client credentials; `refresh_token` in the response (if any) is ignored.
- **No API-key header.** Despite what the public docs imply, this server never sends an `X-API-Key`, `Api-Key`, or similar header — only `Authorization: Bearer <oauth_access_token>`.

### Failure surfaces

- Startup fails (`src/index.ts:41`) if the token exchange fails — typically bad client id/secret, wrong token URL, or network/DNS issues.
- `handleApiError` at `src/services/client.ts:67` maps 401 specifically to a message pointing at `CGTRADER_CLIENT_ID` / `CGTRADER_CLIENT_SECRET`, because after `withAuthRetry` a surfaced 401 means the freshly-minted token was itself rejected.

## CGTrader REST API surface

Public docs: <https://api.cgtrader.com/docs/index.html>. Base URL: `https://api.cgtrader.com/v1`. Full documented endpoint inventory (as of 2026-04, captured for quick reference so we don't need to re-fetch the docs):

| Resource | Endpoints |
| --- | --- |
| **Models** | `GET /models` · `GET /models/:id` · `POST /models` · `PUT /models/:id` · `DELETE /models/:id` |
| **Categories** | `GET /categories` · `GET /categories/:id` |
| **Files** | `GET /models/:model_id/files` · `GET /models/:model_id/files/:id` (302 → S3 signed URL) · `POST /models/:model_id/files` · `DELETE /models/:model_id/files/:id` |
| **Images** | `GET /models/:model_id/images` · `POST /models/:model_id/images` · `DELETE /models/:model_id/images/:id` |
| **License** | `GET /models/:model_id/license` |
| **File types** | `GET /file_types` · `GET /file_types/:id` |
| **Orders** | `GET /orders` · `GET /orders/:id` · `POST /orders` (returns `checkout_url`) |
| **Users** | `POST /users` · `GET /users/me` |

This server only consumes the `GET` subset, scoped to free models (see free-guard logic in `src/services/free-guard.ts` and `README.md` lines 18–20). The mutating endpoints (`POST`/`PUT`/`DELETE` on models, files, images, orders, users) are documented here for completeness but are **not** callable with our `client_credentials` token — they require a user-authenticated token this server deliberately does not mint.

### What the public API does not expose

There is **no** endpoint for:

- keyword search volume, search counts, or search analytics
- trending / popular keywords
- per-keyword or per-query history
- any time-series / aggregate marketplace metrics

The surface is strictly CRUD over models/files/images/orders/users plus the categories and file-types taxonomies. Any "how popular is search term X" question cannot be answered via this API; it would need an internal data source (warehouse / analytics pipeline) outside this server's scope.
