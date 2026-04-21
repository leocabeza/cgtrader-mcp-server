# cgtrader-mcp-server

MCP server exposing the [CGTrader](https://api.cgtrader.com) marketplace — **free models only**. Talks to MCP clients over **streamable HTTP**.

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

## Setup

### 1. Register an OAuth application

Go to <https://www.cgtrader.com/oauth/applications/new> and create an app:

- **Name:** anything you'll recognize (e.g. "CGTrader MCP Server").
- **Redirect URI:** `http://127.0.0.1:3000/oauth/callback` (not used by `client_credentials` at runtime, but Doorkeeper requires the field be non-empty; if the form rejects non-HTTPS URIs, use `urn:ietf:wg:oauth:2.0:oob` instead).
- **Confidential / Trusted:** yes — this is a server-side app with a secret.

Copy the issued **client_id** and **client_secret**.

### 2. Install and configure

```bash
npm install
npm run build

cp .env.example .env   # then fill in CGTRADER_CLIENT_ID / CGTRADER_CLIENT_SECRET
```

### 3. Run

```bash
export CGTRADER_CLIENT_ID=...
export CGTRADER_CLIENT_SECRET=...
npm start
# OAuth client_credentials token acquired successfully.
# cgtrader-mcp-server v0.1.0 listening on http://127.0.0.1:3000/mcp
```

The server performs an OAuth `client_credentials` exchange at startup to fail fast on bad credentials, then caches the access token and refreshes it automatically (60s before `expires_in`, or on any 401 response).

### Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `CGTRADER_CLIENT_ID` | _(required)_ | OAuth application client id. |
| `CGTRADER_CLIENT_SECRET` | _(required)_ | OAuth application client secret. |
| `CGTRADER_OAUTH_TOKEN_URL` | `https://www.cgtrader.com/oauth/token` | Override if CGTrader's token endpoint differs. |
| `CGTRADER_OAUTH_SCOPE` | _(unset)_ | Optional scope to request. |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. Keep on loopback unless you add auth in front. |

## Endpoints

- `POST /mcp` — MCP streamable HTTP endpoint (stateless per-request).
- `GET /healthz` — simple liveness check.

## Development

```bash
npm run dev   # tsx watch
npm run build # tsc -> dist/
```

## Notes

- `cgtrader_download_free_file` does **not** stream binary data through the MCP — it returns the signed redirect URL so the client can download directly. Signed URLs are short-lived; fetch promptly.
- CGTrader's public API docs describe "API key" auth, but the `/oauth/applications` URL pattern is standard Doorkeeper OAuth 2. This server uses `client_credentials` to get a bearer token from the OAuth token endpoint, which is then used on every `api.cgtrader.com/v1/*` call.
# cgtrader-mcp-server
