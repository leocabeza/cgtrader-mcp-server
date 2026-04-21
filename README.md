# cgtrader-mcp-server

MCP server exposing the [CGTrader](https://api.cgtrader.com) marketplace — **free models only**. Runs on **Cloudflare Workers**, speaks MCP over **Streamable HTTP**, and gates `/mcp` behind **OAuth 2.1** federated to **Google Workspace SSO** (`@cgtrader.com` accounts only by default).

## Tools

| Tool | Purpose |
| --- | --- |
| `cgtrader_search_models` | Search free models (keywords, category, product type, extensions, polygon bucket, attribute flags, sort, pagination). |
| `cgtrader_get_model` | Full model details by id. Rejects paid models. |
| `cgtrader_get_model_images` | List images for a free model. |
| `cgtrader_get_model_license` | License info for a free model. |
| `cgtrader_download_free_file` | Resolve the signed download URL for one file on a free model. |
| `cgtrader_get_free_model_download_urls` | Resolve signed URLs for **every** file on a free model in a single call (preferred when the user wants the whole model). |
| `cgtrader_list_categories` | Full category taxonomy. |
| `cgtrader_get_category` | Single category detail. |

The free-only guarantee is enforced two ways:
1. `cgtrader_search_models` forces `min_price=0` and `max_price=0` on the API request.
2. Every per-model tool (`get_model`, `get_model_images`, `get_model_license`, `download_free_file`) fetches `/v1/models/:id` and refuses if `prices.download !== 0`.

## Architecture

- `src/worker.ts` — Workers entrypoint. Exports an `OAuthProvider` that gates `/mcp` behind OAuth 2.1 and delegates everything else (`/authorize`, `/oauth-callback`, `/healthz`) to the default handler. Also implements `/token`, `/register`, and `/.well-known/oauth-authorization-server`.
- `src/auth/google-handler.ts` — The default handler. `/authorize` redirects to Google with the `AuthRequest` encoded in `state`. `/oauth-callback` exchanges the Google code, decodes the `id_token`, enforces the `@cgtrader.com` domain, and calls `completeAuthorization` so the provider can issue an MCP access token. Also serves `/healthz`.
- `src/mcp-agent.ts` — `CgTraderMCP extends McpAgent<Env, unknown, AuthProps>`. Lives in a SQLite-backed Durable Object (binding `MCP_OBJECT`). Registers tools in `init()` and warms the CGTrader OAuth token before any request is served. The authenticated user's props (`email`, `sub`, `name`) are available as `this.props`.
- `src/services/token.ts` — CGTrader-side OAuth `client_credentials` (server → CGTrader, separate from the Google-side user auth). In-memory cache with refresh leeway; invalidated on 401.
- `src/services/client.ts` — Thin `fetch` wrapper that attaches `Authorization: Bearer <cgtrader-token>` and retries once on 401.
- `src/tools/*.ts` — Tool definitions. Receive `env` via `registerModelTools(server, env)` / `registerCategoryTools(server, env)`.

## Requirements

- **Node.js ≥ 20** (enforced via `package.json#engines`) and npm.
- **Cloudflare account** (free Workers plan is enough) — sign up at <https://dash.cloudflare.com/sign-up>. Wrangler will prompt for browser login on first use; no global binary install needed (it's a devDependency and runs via `npx`/`npm run`).
- **Google Cloud project** — for creating the OAuth 2.0 client in step 2 of Setup.
- **CGTrader account** — to register the OAuth application in step 1 of Setup.

## Setup

### 1. Register an OAuth application on CGTrader

Go to <https://www.cgtrader.com/oauth/applications/new> and create an app:

- **Name:** anything recognizable (e.g. "CGTrader MCP Server").
- **Redirect URI:** `http://127.0.0.1/oauth/callback` (not used by `client_credentials` at runtime, but Doorkeeper requires the field be non-empty; if the form rejects non-HTTPS URIs, use `urn:ietf:wg:oauth:2.0:oob`).
- **Confidential / Trusted:** yes — this is a server-side app with a secret.

Copy the issued **client_id** and **client_secret**.

### 2. Register a Google Cloud OAuth 2.0 Client

This is what Claude's Custom Connector will use (indirectly) to sign users in with Google Workspace.

- Google Cloud Console → <https://console.cloud.google.com/apis/credentials>
- **Create Credentials → OAuth client ID**
- **Application type:** Web application
- **Authorized redirect URIs:**
  - `http://127.0.0.1:8787/oauth-callback` (local dev)
  - `https://<your-worker-subdomain>.workers.dev/oauth-callback` (prod — add once deployed)
- Under the consent screen settings, set **User type: Internal** so only your Workspace can sign in.

Copy the resulting **Client ID** and **Client secret**.

### 3. Install

```bash
npm install
```

### 4. Create `.dev.vars` (local secrets for `wrangler dev`)

```bash
cp .dev.vars.example .dev.vars
```

Then fill in the four credentials from steps 1 and 2. `.dev.vars` is the Wrangler equivalent of `.env` — auto-loaded by `wrangler dev` and gitignored. Production secrets are set with `wrangler secret put` (see [Deploy](#deploy)).

### Environment variables

| Var | Kind | Default | Notes |
| --- | --- | --- | --- |
| `CGTRADER_CLIENT_ID` | secret | _(required)_ | CGTrader OAuth app client id. |
| `CGTRADER_CLIENT_SECRET` | secret | _(required)_ | CGTrader OAuth app client secret. |
| `CGTRADER_OAUTH_TOKEN_URL` | var | `https://www.cgtrader.com/oauth/token` | Override if CGTrader's token endpoint differs. |
| `CGTRADER_OAUTH_SCOPE` | var | _(unset)_ | Optional scope to request. |
| `GOOGLE_CLIENT_ID` | secret | _(required)_ | Google OAuth Client ID. |
| `GOOGLE_CLIENT_SECRET` | secret | _(required)_ | Google OAuth Client Secret. |
| `ALLOWED_EMAIL_DOMAIN` | var | `cgtrader.com` | Email domain allow-list (checked against Google's `hd` claim and `email` suffix). Unset to disable. |

## Development

### Run locally

```bash
npm run dev
# ⎔ Starting local server...
# [wrangler:info] Ready on http://localhost:8787
```

This starts `wrangler dev`, which runs the Worker in a local Miniflare sandbox (including an in-memory KV for the OAuth provider's grant/token storage). Useful endpoints:

- `http://localhost:8787/mcp` — MCP Streamable HTTP endpoint (requires a valid access token).
- `http://localhost:8787/healthz` — liveness check (unauth).
- `http://localhost:8787/.well-known/oauth-authorization-server` — OAuth metadata discovery (unauth).

### Typecheck

```bash
npm run typecheck
```

## Testing with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is Anthropic's official web UI for debugging MCP servers. It supports OAuth 2.1 discovery, so it will drive the full Google sign-in flow end-to-end and then let you exercise tools.

1. Start the server: `npm run dev`
2. In another terminal: `npx @modelcontextprotocol/inspector`. Opens `http://127.0.0.1:6274`.
3. In the inspector UI:
   - **Transport:** `Streamable HTTP`
   - **URL:** `http://localhost:8787/mcp`
   - Paste the **Proxy Session Token** printed in the `npx` terminal.
   - Click **Connect**. You'll be redirected to Google, pick your `@cgtrader.com` account, consented back to the inspector, then arrive at the Tools tab.
4. **Tools → List Tools** shows the eight `cgtrader_*` tools. Pick one, fill in arguments, **Run Tool**. The **History** tab shows raw JSON-RPC frames for debugging.

### Unauth smoke checks (no OAuth needed)

```bash
curl -sS http://localhost:8787/healthz
curl -sS http://localhost:8787/.well-known/oauth-authorization-server | jq
curl -sS -i http://localhost:8787/mcp   # expect 401 invalid_token
```

## Deploy

### 1. Create the OAuth KV namespace (once)

```bash
wrangler kv namespace create OAUTH_KV
```

Copy the returned `id` into `wrangler.jsonc` under `kv_namespaces[0].id` (replaces the placeholder).

### 2. Set production secrets (once, or when rotating)

```bash
wrangler secret put CGTRADER_CLIENT_ID
wrangler secret put CGTRADER_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

### 3. Deploy

```bash
npm run deploy   # wrangler deploy
```

Once deployed, add the prod `oauth-callback` URL (`https://<worker>.workers.dev/oauth-callback`) to the Google OAuth client's **Authorized redirect URIs** in the Google Cloud Console.

Users add the server to Claude as a **Custom Connector** pointing at `https://<worker>.workers.dev/mcp` — Claude performs Dynamic Client Registration, OAuth discovery, and the Google sign-in dance automatically. No config files, no shared secrets handed out to teammates.

## Endpoints

- `POST /mcp` — MCP Streamable HTTP endpoint. Requires a bearer access token issued by this provider.
- `GET /.well-known/oauth-authorization-server` — OAuth 2.1 server metadata (RFC 8414).
- `POST /register` — Dynamic Client Registration (RFC 7591). Claude uses this to register itself.
- `GET /authorize` — Authorization endpoint. Redirects to Google.
- `GET /oauth-callback` — Returns from Google, issues the MCP access token.
- `POST /token` — Token endpoint (code → access token exchange, refresh).
- `GET /healthz` — Liveness check (unauth).

## Notes

- `cgtrader_download_free_file` and `cgtrader_get_free_model_download_urls` do **not** stream binary data through MCP — they return short-lived signed S3 URLs meant for the end user's browser. Fetch promptly.
- CGTrader's public API docs describe "API key" auth, but the `/oauth/applications` URL pattern is standard Doorkeeper OAuth 2. The server uses `client_credentials` to get a bearer token for CGTrader (separate from the user-facing Google auth).
- The user-facing `@cgtrader.com` domain check is enforced in two places: Google's own `hd` query-param hint on the consent screen, and a server-side re-check against both the `hd` claim and the `email` claim of the returned `id_token`. Trust the server-side check; the `hd` hint is only a UX nicety.
