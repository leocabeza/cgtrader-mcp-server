# cgtrader-mcp-server

MCP server exposing the [CGTrader](https://api.cgtrader.com) marketplace — **free models only**. Runs on **Cloudflare Workers** and speaks MCP over **Streamable HTTP**.

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

- `src/worker.ts` — Workers entrypoint. Routes `/healthz` and `/mcp`.
- `src/mcp-agent.ts` — `CgTraderMCP extends McpAgent<Env>`. Lives in a SQLite-backed Durable Object (binding `MCP_OBJECT`). Registers tools in `init()` and warms the OAuth token before any request is served.
- `src/services/token.ts` — OAuth `client_credentials` against CGTrader. In-memory cache with refresh leeway; invalidated on 401.
- `src/services/client.ts` — Thin `fetch` wrapper that attaches `Authorization: Bearer <token>` and retries once on 401.
- `src/tools/*.ts` — Tool definitions. Receive `env` via `registerModelTools(server, env)` / `registerCategoryTools(server, env)` so tool closures can reach the OAuth credentials without module-level state.

## Setup

### 1. Register an OAuth application on CGTrader

Go to <https://www.cgtrader.com/oauth/applications/new> and create an app:

- **Name:** anything recognizable (e.g. "CGTrader MCP Server").
- **Redirect URI:** `http://127.0.0.1/oauth/callback` (not used by `client_credentials` at runtime, but Doorkeeper requires the field be non-empty; if the form rejects non-HTTPS URIs, use `urn:ietf:wg:oauth:2.0:oob`).
- **Confidential / Trusted:** yes — this is a server-side app with a secret.

Copy the issued **client_id** and **client_secret**.

### 2. Install

```bash
npm install
```

### 3. Create `.dev.vars` (local secrets for `wrangler dev`)

```
CGTRADER_CLIENT_ID=your-client-id
CGTRADER_CLIENT_SECRET=your-client-secret
```

`.dev.vars` is the Wrangler equivalent of `.env` — it's auto-loaded by `wrangler dev` and is gitignored. For production secrets, use `wrangler secret put CGTRADER_CLIENT_ID` / `wrangler secret put CGTRADER_CLIENT_SECRET` instead.

### Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `CGTRADER_CLIENT_ID` | _(required)_ | OAuth application client id. |
| `CGTRADER_CLIENT_SECRET` | _(required)_ | OAuth application client secret. |
| `CGTRADER_OAUTH_TOKEN_URL` | `https://www.cgtrader.com/oauth/token` | Override if CGTrader's token endpoint differs. |
| `CGTRADER_OAUTH_SCOPE` | _(unset)_ | Optional scope to request. |

## Development

### Run locally

```bash
npm run dev
# ⎔ Starting local server...
# [wrangler:info] Ready on http://localhost:8787
```

This starts `wrangler dev`, which runs the Worker in a local Miniflare sandbox. The MCP endpoint is `http://localhost:8787/mcp`; liveness is at `http://localhost:8787/healthz`.

### Typecheck

```bash
npm run typecheck
```

### Deploy

```bash
npm run deploy   # wrangler deploy
```

Before the first deploy, set production secrets:

```bash
wrangler secret put CGTRADER_CLIENT_ID
wrangler secret put CGTRADER_CLIENT_SECRET
```

## Testing with MCP Inspector

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is Anthropic's official web UI for debugging MCP servers. It connects to any MCP server and lets you interactively browse tool/resource/prompt definitions, call tools with arbitrary arguments, and inspect the JSON-RPC traffic. It's the best tool for developing a server — much faster than round-tripping through Claude Desktop.

### Usage

1. Start the server:
   ```bash
   npm run dev
   ```
2. In another terminal, launch the inspector (no install needed — `npx` fetches it):
   ```bash
   npx @modelcontextprotocol/inspector
   ```
   It opens a browser tab at `http://127.0.0.1:6274`.
3. In the inspector UI:
   - **Transport:** `Streamable HTTP`
   - **URL:** `http://localhost:8787/mcp`
   - Paste the **Proxy Session Token** printed in the `npx` terminal.
   - Click **Connect**.
4. Exercise the server:
   - Open **Tools → List Tools** — you should see all eight `cgtrader_*` tools.
   - Pick one (e.g. `cgtrader_list_categories`), fill in arguments in the right-hand panel, hit **Run Tool**.
   - The `History` tab shows the raw JSON-RPC frames — useful for debugging schemas or unexpected shapes.

### Quick curl smoke test (no inspector)

```bash
# initialize → capture the session id
SESSION_ID=$(curl -sS -D - -o /dev/null -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' \
  | grep -i '^mcp-session-id:' | sed 's/.*: *//' | tr -d '\r\n')

# send initialized notification
curl -sS -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# list tools
curl -sS -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## Endpoints

- `POST /mcp` — MCP Streamable HTTP endpoint.
- `GET /healthz` — liveness check.

## Notes

- `cgtrader_download_free_file` and `cgtrader_get_free_model_download_urls` do **not** stream binary data through MCP — they return short-lived signed S3 URLs meant for the end user's browser. Fetch promptly.
- CGTrader's public API docs describe "API key" auth, but the `/oauth/applications` URL pattern is standard Doorkeeper OAuth 2. This server uses `client_credentials` to get a bearer token, which is then used on every `api.cgtrader.com/v1/*` call.
- The MCP endpoint is currently **unauthenticated** and is only safe on localhost. OAuth 2.1 with Google Workspace SSO will gate `/mcp` in front of the Durable Object before any public deployment.
