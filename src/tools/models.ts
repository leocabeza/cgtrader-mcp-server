import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { Env } from "../env.js";
import {
  CGTraderImage,
  CGTraderLicense,
  CGTraderModel,
  CGTraderModelListResponse,
} from "../types.js";
import { apiGet, apiGetRaw, handleApiError } from "../services/client.js";
import { elicitForm, type FormSchema } from "../services/elicit.js";
import {
  FreeOnlyViolation,
  fetchFreeModelOrThrow,
  isFreeModel,
} from "../services/free-guard.js";
import { modelsToMarkdown, renderText } from "../services/format.js";
import {
  UrlResolutionError,
  resolveModelId,
} from "../services/url-resolver.js";
import {
  categoryIdField,
  modelIdField,
  pageField,
  perPageField,
  responseFormatField,
} from "../schemas/common.js";

const modelUrlField = z
  .string()
  .url()
  .describe(
    "CGTrader URL — either a product page (https://www.cgtrader.com/free-3d-models/...) or a download page (https://www.cgtrader.com/items/{id}/download-page). Use this OR model_id.",
  );
import searchUiHtml from "../../ui/search/dist/index.html";
import modelDetailUiHtml from "../../ui/model-detail/dist/index.html";
import modelPreviewUiHtml from "../../ui/model-preview/dist/index.html";

const SEARCH_UI_RESOURCE_URI = "ui://cgtrader/search.html";
const MODEL_DETAIL_UI_RESOURCE_URI = "ui://cgtrader/model-detail.html";
const MODEL_PREVIEW_UI_RESOURCE_URI = "ui://cgtrader/model-preview.html";

// CGTrader serves model thumbnails from img-new.cgtrader.com (confirmed
// 2026-04-22). The wildcard covers sibling subdomains in case the CDN host
// rotates; tighten to the specific host if CSP exposure becomes a concern.
const CGTRADER_IMG_DOMAINS = ["https://*.cgtrader.com"];
// Signed download URLs resolve to AWS S3 (cgtfiles bucket). Must be in the
// UI's connectDomains so the 3D viewer can XHR the model bytes from inside
// the sandboxed iframe.
const CGTRADER_S3_DOMAIN = "https://cgtfiles.s3.amazonaws.com";
// Draco decoder files needed by @cgtrader/cgt-viewer for compressed glTF.
// Served from a public CDN rather than bundled — the decoder is ~200 KB of
// wasm that we don't want inlined into every UI bundle.
const DRACO_CDN_DOMAIN = "https://cdn.jsdelivr.net";

// Formats @cgtrader/cgt-viewer can render in-browser, in decreasing order of
// preference. `.glb` is self-contained and always wins; plain `.gltf` is
// skipped in favor of `.glb` because its external .bin / textures make
// multi-file loads a nuisance without resolved asset URLs.
const VIEWER_PREFERRED_EXTENSIONS = ["glb", "fbx", "obj", "stl", "gltf"] as const;
type ViewerExtension = (typeof VIEWER_PREFERRED_EXTENSIONS)[number];
const VIEWER_EXTENSION_SET: ReadonlySet<string> = new Set(
  VIEWER_PREFERRED_EXTENSIONS,
);

function registerSearchUiResource(server: McpServer) {
  registerAppResource(
    server,
    "CGTrader Search",
    SEARCH_UI_RESOURCE_URI,
    {
      description: "Interactive grid UI for free CGTrader model search.",
    },
    async () => ({
      contents: [
        {
          uri: SEARCH_UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: searchUiHtml,
          _meta: {
            ui: {
              csp: {
                resourceDomains: CGTRADER_IMG_DOMAINS,
              },
            },
          },
        },
      ],
    }),
  );
}

function registerModelDetailUiResource(server: McpServer) {
  registerAppResource(
    server,
    "CGTrader Model Detail",
    MODEL_DETAIL_UI_RESOURCE_URI,
    {
      description:
        "Detail view for a single free CGTrader model: image gallery, metadata, and download CTAs.",
    },
    async () => ({
      contents: [
        {
          uri: MODEL_DETAIL_UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: modelDetailUiHtml,
          _meta: {
            ui: {
              csp: {
                resourceDomains: [...CGTRADER_IMG_DOMAINS, DRACO_CDN_DOMAIN],
                connectDomains: [CGTRADER_S3_DOMAIN, DRACO_CDN_DOMAIN],
              },
            },
          },
        },
      ],
    }),
  );
}

function registerModelPreviewUiResource(server: McpServer) {
  registerAppResource(
    server,
    "CGTrader Model Preview",
    MODEL_PREVIEW_UI_RESOURCE_URI,
    {
      description:
        "Interactive 3D preview for a free CGTrader model (WebGPU/WebGL via @cgtrader/cgt-viewer).",
    },
    async () => ({
      contents: [
        {
          uri: MODEL_PREVIEW_UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: modelPreviewUiHtml,
          _meta: {
            ui: {
              csp: {
                resourceDomains: [...CGTRADER_IMG_DOMAINS, DRACO_CDN_DOMAIN],
                connectDomains: [CGTRADER_S3_DOMAIN, DRACO_CDN_DOMAIN],
              },
            },
          },
        },
      ],
    }),
  );
}

// ─── search_models ───────────────────────────────────────────────────────────

const SortEnum = z.enum([
  "best_match",
  "sales",
  "newest",
  "oldest",
  "lower_price",
  "higher_price",
]);

const PolygonsEnum = z.enum([
  "lt_5k",
  "range_5k_10k",
  "range_10k_50k",
  "range_50k_100k",
  "range_100k_250k",
  "gt_250k",
]);

const SearchModelsInputSchema = z
  .object({
    keywords: z
      .string()
      .max(200)
      .optional()
      .describe("Free-text search query matched against model titles/descriptions."),
    category_id: categoryIdField
      .optional()
      .describe("Restrict results to a specific category id."),
    product_type: z
      .enum(["cg", "printable"])
      .optional()
      .describe("Product type: 'cg' (computer graphics) or 'printable' (3D-printable)."),
    extensions: z
      .string()
      .optional()
      .describe("Comma-separated file extensions (e.g. 'obj,stl,fbx')."),
    polygons: PolygonsEnum.optional().describe("Polygon count bucket."),
    low_poly: z.boolean().optional(),
    animated: z.boolean().optional(),
    rigged: z.boolean().optional(),
    pbr: z.boolean().optional(),
    adult_content: z.boolean().default(false),
    sort: SortEnum.default("best_match").describe("Sort order."),
    page: pageField,
    per_page: perPageField,
    response_format: responseFormatField,
  })
  .strict();

type SearchModelsInput = z.infer<typeof SearchModelsInputSchema>;

const COMMON_EXTENSIONS: Array<{ const: string; title: string }> = [
  { const: "any", title: "No preference" },
  { const: "obj", title: "Wavefront OBJ (.obj)" },
  { const: "fbx", title: "Autodesk FBX (.fbx)" },
  { const: "blend", title: "Blender (.blend)" },
  { const: "stl", title: "STL (.stl) — for 3D printing" },
  { const: "3ds", title: "3D Studio (.3ds)" },
  { const: "max", title: "3ds Max (.max)" },
  { const: "gltf", title: "glTF (.gltf/.glb)" },
  { const: "dae", title: "Collada (.dae)" },
];

const POLYGON_OPTIONS: Array<{ const: string; title: string }> = [
  { const: "any", title: "No preference" },
  { const: "lt_5k", title: "Very simple (under 5k polys)" },
  { const: "range_5k_10k", title: "Simple (5k–10k)" },
  { const: "range_10k_50k", title: "Medium (10k–50k)" },
  { const: "range_50k_100k", title: "Detailed (50k–100k)" },
  { const: "range_100k_250k", title: "High-detail (100k–250k)" },
  { const: "gt_250k", title: "Very high-detail (250k+)" },
];

const SORT_OPTIONS: Array<{ const: string; title: string }> = [
  { const: "best_match", title: "Best match (default)" },
  { const: "sales", title: "Most downloaded" },
  { const: "newest", title: "Newest first" },
  { const: "oldest", title: "Oldest first" },
];

function hasAnyRefinement(p: SearchModelsInput): boolean {
  return (
    p.polygons !== undefined ||
    p.low_poly !== undefined ||
    p.animated !== undefined ||
    p.rigged !== undefined ||
    p.pbr !== undefined ||
    p.extensions !== undefined ||
    p.product_type !== undefined
  );
}

const SEARCH_REFINE_SCHEMA: FormSchema = {
  type: "object",
  properties: {
    format: {
      type: "string",
      title: "Preferred file format",
      oneOf: COMMON_EXTENSIONS,
      default: "any",
    },
    complexity: {
      type: "string",
      title: "Model complexity",
      oneOf: POLYGON_OPTIONS,
      default: "any",
    },
    sort: {
      type: "string",
      title: "Sort results by",
      oneOf: SORT_OPTIONS,
      default: "best_match",
    },
    notes: {
      type: "string",
      title: "Anything else we should know? (optional)",
      description:
        "Free-text hint for the assistant — e.g. 'needs to open in Cinema 4D' or 'must be rigged for Unity'.",
    },
  },
};

type SearchRefineValues = {
  format?: string;
  complexity?: string;
  sort?: string;
  notes?: string;
};

const DECLINE_HINT =
  "> **User declined the refinement prompt.** If they seem unsatisfied with the results below, re-prompt them in natural language to describe what they actually want.";

function buildSearchParams(p: SearchModelsInput): Record<string, unknown> {
  const apiParams: Record<string, unknown> = {
    page: p.page,
    per_page: p.per_page,
    sort: p.sort,
    adult_content: p.adult_content,
    // free-only enforcement:
    min_price: 0,
    max_price: 0,
  };
  if (p.keywords) apiParams.keywords = p.keywords;
  if (p.category_id !== undefined) apiParams.category_id = p.category_id;
  if (p.product_type) apiParams.product_type = p.product_type;
  if (p.extensions) apiParams.extensions = p.extensions;
  if (p.polygons) apiParams.polygons = p.polygons;
  if (p.low_poly !== undefined) apiParams.low_poly = p.low_poly;
  if (p.animated !== undefined) apiParams.animated = p.animated;
  if (p.rigged !== undefined) apiParams.rigged = p.rigged;
  if (p.pbr !== undefined) apiParams.pbr = p.pbr;
  return apiParams;
}

function registerSearchModels(server: McpServer, env: Env) {
  registerAppTool(
    server,
    "cgtrader_search_models",
    {
      title: "Search free CGTrader models",
      _meta: { ui: { resourceUri: SEARCH_UI_RESOURCE_URI } },
      description: `Search the CGTrader marketplace for FREE 3D models (price = 0).

This server only exposes free content; the price filter is enforced server-side (max_price=0) and cannot be overridden.

Args:
  - keywords (string, optional): Free-text search query.
  - category_id (number, optional): Restrict to a specific category.
  - product_type ('cg' | 'printable', optional): Asset type.
  - extensions (string, optional): Comma-separated file extensions (e.g. "obj,stl").
  - polygons (enum, optional): Polygon bucket (lt_5k, range_5k_10k, range_10k_50k, range_50k_100k, range_100k_250k, gt_250k).
  - low_poly, animated, rigged, pbr (boolean, optional): Attribute filters.
  - adult_content (boolean, default false): Include adult content.
  - sort (enum, default 'best_match'): best_match | sales | newest | oldest | lower_price | higher_price.
  - page (int, default 1), per_page (int, default 25, max 100): Pagination.
  - response_format ('markdown' | 'json', default 'markdown').

Returns (JSON shape):
  {
    total: number,
    count: number,
    page: number,
    per_page: number,
    has_more: boolean,
    next_page: number | null,
    models: [{ id, title, author_name, url, category_id, subcategory_id,
               tags, prices: { download: 0 }, thumbnails, availableFileExtensions,
               animated, rigged, game_ready, downloadable }]
  }

Example:
  - "Find free low-poly animated character models" → keywords="character", low_poly=true, animated=true.
  - "Browse free printable miniatures" → product_type="printable", keywords="miniature".`,
      inputSchema: SearchModelsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchModelsInput) => {
      try {
        let effective: SearchModelsInput = params;
        let userNotes: string | null = null;
        let userDeclined = false;

        let data = await apiGet<CGTraderModelListResponse>(
          env,
          "/models",
          buildSearchParams(effective),
        );

        // Post-search refinement: only prompt on broad, first-page requests
        // where the caller hasn't already narrowed anything. The grid is more
        // informative than a blind pre-search form — the elicit references
        // the actual result count.
        const firstTotal = data.total ?? 0;
        const shouldRefine =
          effective.page === 1 &&
          !hasAnyRefinement(effective) &&
          firstTotal > effective.per_page;

        if (shouldRefine) {
          const outcome = await elicitForm<SearchRefineValues>(
            server,
            effective.keywords
              ? `Found ${firstTotal.toLocaleString()} free models for "${effective.keywords}". Narrow it down, or submit as-is to browse.`
              : `Found ${firstTotal.toLocaleString()} free models. Narrow it down, or submit as-is to browse.`,
            SEARCH_REFINE_SCHEMA,
          );
          if (outcome.status === "accepted") {
            const v = outcome.values;
            if (typeof v.notes === "string" && v.notes.trim() !== "") {
              userNotes = v.notes.trim();
            }
            const refined: SearchModelsInput = {
              ...effective,
              ...(v.format && v.format !== "any"
                ? { extensions: v.format }
                : {}),
              ...(v.complexity && v.complexity !== "any"
                ? { polygons: v.complexity as SearchModelsInput["polygons"] }
                : {}),
              ...(v.sort ? { sort: v.sort as SearchModelsInput["sort"] } : {}),
            };
            const narrowed =
              refined.extensions !== effective.extensions ||
              refined.polygons !== effective.polygons ||
              refined.sort !== effective.sort;
            if (narrowed) {
              effective = refined;
              data = await apiGet<CGTraderModelListResponse>(
                env,
                "/models",
                buildSearchParams(effective),
              );
            }
          } else if (outcome.status === "declined") {
            userDeclined = true;
          }
        }

        // Defensive: drop anything the API returns that isn't actually free.
        const freeModels = (data.models ?? []).filter(isFreeModel);
        const total = data.total ?? freeModels.length;
        const consumed = effective.page * effective.per_page;
        const has_more = total > consumed;

        const structured = {
          total,
          count: freeModels.length,
          page: effective.page,
          per_page: effective.per_page,
          has_more,
          next_page: has_more ? effective.page + 1 : null,
          models: freeModels,
        };

        const baseMarkdown = modelsToMarkdown(
          "Free model search results",
          freeModels,
          {
            page: effective.page,
            per_page: effective.per_page,
            total,
            has_more,
          },
        );
        const hintParts: string[] = [];
        if (userNotes) {
          hintParts.push(
            `> **User added a note:** ${userNotes}\n>\n> Take this into account; if the results don't match, ask the user to clarify.`,
          );
        }
        if (userDeclined) {
          hintParts.push(DECLINE_HINT);
        }
        const markdown = hintParts.length
          ? `${baseMarkdown}\n\n---\n\n${hintParts.join("\n\n")}`
          : baseMarkdown;

        const text = renderText(effective.response_format, markdown, structured);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

// ─── get_model ───────────────────────────────────────────────────────────────

const GetModelInputSchema = z
  .object({
    model_id: modelIdField.optional(),
    url: modelUrlField.optional(),
    response_format: responseFormatField,
  })
  .strict();

type GetModelInput = z.infer<typeof GetModelInputSchema>;

function modelToMarkdown(m: CGTraderModel): string {
  const lines: string[] = [];
  lines.push(`# ${m.title ?? `Model ${m.id}`} (id: ${m.id})`);
  if (m.author_name) lines.push(`**Author:** ${m.author_name}`);
  if (m.url) lines.push(`**URL:** ${m.url}`);
  lines.push(
    `**Price (download):** ${m.prices?.download ?? "unknown"} (free-only filter active)`,
  );
  if (m.category_id) lines.push(`**Category id:** ${m.category_id}`);
  if (m.license) lines.push(`**License:** ${m.license}`);
  if (m.tags?.length) lines.push(`**Tags:** ${m.tags.join(", ")}`);
  if (m.availableFileExtensions?.length)
    lines.push(`**Extensions:** ${m.availableFileExtensions.join(", ")}`);
  if (m.description) {
    lines.push("");
    lines.push("## Description");
    lines.push(m.description);
  }
  if (m.files?.length) {
    lines.push("");
    lines.push("## Files");
    for (const f of m.files) {
      lines.push(`- id ${f.id}: ${f.name ?? "(unnamed)"}`);
    }
  }
  return lines.join("\n");
}

const NEXT_ACTION_SCHEMA: FormSchema = {
  type: "object",
  properties: {
    next: {
      type: "string",
      title: "What next?",
      oneOf: [
        { const: "done", title: "Nothing — I'm done" },
        { const: "images", title: "Show preview images" },
        { const: "license", title: "Show license / usage terms" },
        { const: "downloads", title: "Get download links" },
      ],
      default: "done",
    },
    notes: {
      type: "string",
      title: "Anything else? (optional)",
      description:
        "Free-text hint for the assistant — e.g. 'convert to STL for printing' or 'summarize the license'.",
    },
  },
};

const NEXT_ACTION_TOOL: Record<string, string> = {
  images: "cgtrader_get_model_images",
  license: "cgtrader_get_model_license",
  downloads: "cgtrader_get_free_model_download_urls",
};

function registerGetModel(server: McpServer, env: Env) {
  server.registerTool(
    "cgtrader_get_model",
    {
      title: "Get free CGTrader model details",
      description: `Fetch full details for a single CGTrader model.

Accepts either a numeric model_id or a CGTrader URL (product page or /items/{id}/download-page). Provide exactly one.

Rejects with an error if the model is not free (download price > 0). Use cgtrader_search_models to find free models first.

On hosts that support MCP elicitation, this tool may ask the user a quick follow-up ("images / license / downloads / done"); the chosen action is surfaced as a hint so the agent can call the next tool immediately.

Args:
  - model_id (number, optional): CGTrader model id.
  - url (string, optional): CGTrader product page or /items/{id}/download-page URL.
  - response_format ('markdown' | 'json', default 'markdown').

Returns: the full model object (id, title, author_name, url, category_id, subcategory_id, description, tags, prices, files, availableFileExtensions, thumbnails, animated, rigged, game_ready, license, ...).`,
      inputSchema: GetModelInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetModelInput) => {
      try {
        const modelId = await resolveModelId({
          model_id: params.model_id,
          url: params.url,
        });
        const model = await fetchFreeModelOrThrow(env, modelId);
        const baseMd = modelToMarkdown(model);

        const outcome = await elicitForm<{ next?: string; notes?: string }>(
          server,
          `You fetched "${model.title ?? `model ${model.id}`}". What would you like next?`,
          NEXT_ACTION_SCHEMA,
        );

        const hintLines: string[] = [];
        let nextAction: string | null = null;
        let userNotes: string | null = null;
        if (outcome.status === "accepted") {
          const choice = outcome.values.next;
          if (choice && choice !== "done") {
            const tool = NEXT_ACTION_TOOL[choice];
            if (tool) {
              nextAction = choice;
              hintLines.push(
                `**User requested next action:** ${choice}. Call \`${tool}\` with \`model_id=${model.id}\` to fulfill it.`,
              );
            }
          }
          const notes = outcome.values.notes;
          if (typeof notes === "string" && notes.trim() !== "") {
            userNotes = notes.trim();
            hintLines.push(`**User added a note:** ${userNotes}`);
          }
        } else if (outcome.status === "declined") {
          hintLines.push(DECLINE_HINT);
        }

        const hintMd = hintLines.length
          ? `\n\n---\n\n${hintLines.join("\n\n")}`
          : "";

        const text = renderText(
          params.response_format,
          baseMd + hintMd,
          { ...model, _next_action: nextAction, _user_notes: userNotes },
        );
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            ...(model as unknown as Record<string, unknown>),
            _next_action: nextAction,
            _user_notes: userNotes,
          },
        };
      } catch (error) {
        if (error instanceof FreeOnlyViolation) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        if (error instanceof UrlResolutionError) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

// ─── view_model (UI-only) ────────────────────────────────────────────────────

const ViewModelInputSchema = z
  .object({
    model_id: modelIdField.optional(),
    url: modelUrlField.optional(),
  })
  .strict();

type ViewModelInput = z.infer<typeof ViewModelInputSchema>;

function registerViewModel(server: McpServer, env: Env) {
  registerAppTool(
    server,
    "cgtrader_view_model",
    {
      title: "View a free CGTrader model (UI)",
      _meta: { ui: { resourceUri: MODEL_DETAIL_UI_RESOURCE_URI } },
      description: `Render the detail view for a single free CGTrader model.

This tool is optimized for the Model Detail UI: it fetches the model and its preview images in one call and returns them together as structured content. Prefer cgtrader_get_model for plain-text/markdown summaries with follow-up elicitation.

Accepts either a numeric model_id or a CGTrader URL (product page or /items/{id}/download-page). Provide exactly one.

Rejects with an error if the model is not free.

Args:
  - model_id (number, optional): CGTrader model id.
  - url (string, optional): CGTrader product page or /items/{id}/download-page URL.

Returns: { model, images } — the full model object plus an array of preview images.`,
      inputSchema: ViewModelInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ViewModelInput) => {
      try {
        const modelId = await resolveModelId({
          model_id: params.model_id,
          url: params.url,
        });
        // Fetch model (with free-guard) and images in parallel. Images can
        // legitimately 404 or come back empty — don't fail the whole view
        // over it; the gallery falls back to model.thumbnails.
        const modelP = fetchFreeModelOrThrow(env, modelId);
        const imagesP = apiGet<{ images?: CGTraderImage[] } | CGTraderImage[]>(
          env,
          `/models/${modelId}/images`,
        ).catch(() => [] as CGTraderImage[]);
        const [model, imagesRaw] = await Promise.all([modelP, imagesP]);
        const images: CGTraderImage[] = Array.isArray(imagesRaw)
          ? imagesRaw
          : (imagesRaw.images ?? []);

        const structured = { model, images };
        // The LLM-facing text fallback stays terse — the UI is the primary
        // surface for this tool. Keep just enough so a text-only client isn't
        // staring at an empty response.
        const text = `Loaded "${model.title ?? `model ${model.id}`}" (${images.length} preview image${images.length === 1 ? "" : "s"}).`;
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (error instanceof FreeOnlyViolation) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        if (error instanceof UrlResolutionError) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

// ─── get_model_images ────────────────────────────────────────────────────────

const GetModelImagesInputSchema = z
  .object({
    model_id: modelIdField,
    response_format: responseFormatField,
  })
  .strict();

type GetModelImagesInput = z.infer<typeof GetModelImagesInputSchema>;

function registerGetModelImages(server: McpServer, env: Env) {
  server.registerTool(
    "cgtrader_get_model_images",
    {
      title: "Get images for a free CGTrader model",
      description: `List all images attached to a CGTrader model.

Verifies the model is free before returning images.

Args:
  - model_id (number, required).
  - response_format ('markdown' | 'json', default 'markdown').

Returns: { model_id, count, images: [{ id, url, width, height, ... }] }.`,
      inputSchema: GetModelImagesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetModelImagesInput) => {
      try {
        await fetchFreeModelOrThrow(env, params.model_id);
        const data = await apiGet<{ images?: CGTraderImage[] } | CGTraderImage[]>(
          env,
          `/models/${params.model_id}/images`,
        );
        const images: CGTraderImage[] = Array.isArray(data)
          ? data
          : (data.images ?? []);
        const structured = {
          model_id: params.model_id,
          count: images.length,
          images,
        };
        const md = [
          `# Images for model ${params.model_id}`,
          "",
          images.length === 0
            ? "_No images._"
            : images
                .map((img) => `- id ${img.id}${img.url ? ` — ${img.url}` : ""}`)
                .join("\n"),
        ].join("\n");
        const text = renderText(params.response_format, md, structured);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured,
        };
      } catch (error) {
        if (error instanceof FreeOnlyViolation) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

// ─── get_model_license ───────────────────────────────────────────────────────

const GetModelLicenseInputSchema = z
  .object({
    model_id: modelIdField,
    response_format: responseFormatField,
  })
  .strict();

type GetModelLicenseInput = z.infer<typeof GetModelLicenseInputSchema>;

function registerGetModelLicense(server: McpServer, env: Env) {
  server.registerTool(
    "cgtrader_get_model_license",
    {
      title: "Get license info for a free CGTrader model",
      description: `Fetch the license information for a CGTrader model.

Verifies the model is free before returning license details.

Args:
  - model_id (number, required).
  - response_format ('markdown' | 'json', default 'markdown').

Returns: the raw license object from the CGTrader API (name, description, terms, ...).`,
      inputSchema: GetModelLicenseInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetModelLicenseInput) => {
      try {
        await fetchFreeModelOrThrow(env, params.model_id);
        const license = await apiGet<CGTraderLicense>(
          env,
          `/models/${params.model_id}/license`,
        );
        const md = [
          `# License for model ${params.model_id}`,
          "",
          license.name ? `**Name:** ${license.name}` : "",
          license.description ?? "",
        ]
          .filter(Boolean)
          .join("\n");
        const text = renderText(params.response_format, md || "_No license info returned._", license);
        return {
          content: [{ type: "text", text }],
          structuredContent: license as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (error instanceof FreeOnlyViolation) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

// ─── download URL resolution ─────────────────────────────────────────────────

const EXPIRES_HINT =
  "Signed S3 URL — typically expires within a few minutes. If the user's click fails, re-invoke the tool to regenerate.";

const AGENT_HANDOFF_NOTE =
  "IMPORTANT FOR AGENTS: CGTrader's S3 hosts are not on typical agent-sandbox network allowlists. Do NOT attempt to fetch these URLs from a code-execution sandbox — present them directly to the end user as clickable links. The URLs are meant for the user's browser.";

async function resolveSignedUrl(
  env: Env,
  modelId: number,
  fileId: number,
): Promise<string> {
  const res = await apiGetRaw(env, `/models/${modelId}/files/${fileId}`);
  const location = res.headers.get("location");
  if (!location) {
    throw new Error(
      `CGTrader did not return a redirect Location for file ${fileId} on model ${modelId} (status ${res.status}).`,
    );
  }
  return location;
}

function fileLabel(f: { name?: string; id: number }): string {
  return f.name ?? `file ${f.id}`;
}

function fileExtension(name: string | undefined): string | null {
  if (!name) return null;
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : null;
}

// ─── download_free_file (single file) ────────────────────────────────────────

const DownloadFreeFileInputSchema = z
  .object({
    model_id: modelIdField.optional(),
    url: modelUrlField.optional(),
    file_id: z
      .number()
      .int()
      .positive()
      .describe("CGTrader file id (from model.files[].id)."),
  })
  .strict();

type DownloadFreeFileInput = z.infer<typeof DownloadFreeFileInputSchema>;

function registerDownloadFreeFile(server: McpServer, env: Env) {
  server.registerTool(
    "cgtrader_download_free_file",
    {
      title: "Get download URL for a free CGTrader model file",
      description: `Resolve a signed download URL for ONE file on a FREE CGTrader model.

When the user wants to download a model with multiple files, prefer cgtrader_get_free_model_download_urls — it returns every file's URL in a single call instead of one call per file.

Accepts either a numeric model_id or a CGTrader URL (product page or /items/{id}/download-page) to identify the parent model. Provide exactly one.

This tool NEVER streams the binary through MCP. It returns a short-lived S3 signed URL meant for the end user's browser. ${AGENT_HANDOFF_NOTE}

Args:
  - model_id (number, optional): Parent model id. Rejected if not free.
  - url (string, optional): CGTrader product page or /items/{id}/download-page URL.
  - file_id (number, required): File id (from model.files[].id in cgtrader_get_model).

Returns: { model_id, file_id, download_url, expires_hint }.`,
      inputSchema: DownloadFreeFileInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DownloadFreeFileInput) => {
      try {
        const modelId = await resolveModelId({
          model_id: params.model_id,
          url: params.url,
        });
        const model = await fetchFreeModelOrThrow(env, modelId);
        const fileBelongs = model.files?.some((f) => f.id === params.file_id);
        if (model.files && !fileBelongs) {
          return {
            content: [
              {
                type: "text",
                text: `Error: file_id ${params.file_id} does not belong to model ${modelId}. Known file ids: ${model.files.map((f) => f.id).join(", ") || "(none)"}.`,
              },
            ],
            isError: true,
          };
        }

        const url = await resolveSignedUrl(env, modelId, params.file_id);
        const file = model.files?.find((f) => f.id === params.file_id);
        const label = file ? fileLabel(file) : `file ${params.file_id}`;

        const structured = {
          model_id: modelId,
          file_id: params.file_id,
          name: file?.name,
          download_url: url,
          expires_hint: EXPIRES_HINT,
          agent_note: AGENT_HANDOFF_NOTE,
        };
        const md = [
          `# Download link — ${label}`,
          "",
          `[${label}](${url})`,
          "",
          `_${EXPIRES_HINT}_`,
          "",
          `> ${AGENT_HANDOFF_NOTE}`,
        ].join("\n");
        return {
          content: [{ type: "text", text: md }],
          structuredContent: structured,
        };
      } catch (error) {
        if (error instanceof FreeOnlyViolation) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        if (error instanceof UrlResolutionError) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

// ─── get_free_model_download_urls (all files at once) ────────────────────────

const GetFreeModelDownloadUrlsInputSchema = z
  .object({
    model_id: modelIdField.optional(),
    url: modelUrlField.optional(),
  })
  .strict();

type GetFreeModelDownloadUrlsInput = z.infer<
  typeof GetFreeModelDownloadUrlsInputSchema
>;

function registerGetFreeModelDownloadUrls(server: McpServer, env: Env) {
  server.registerTool(
    "cgtrader_get_free_model_download_urls",
    {
      title: "Get all download URLs for a free CGTrader model",
      description: `Resolve signed download URLs for EVERY file attached to a FREE CGTrader model, in a single call.

Prefer this tool over cgtrader_download_free_file whenever the user wants to download a model (they almost always want all the files). It runs the per-file redirect fetches in parallel server-side, so the agent makes ONE tool call instead of N.

Accepts either a numeric model_id or a CGTrader URL (product page or /items/{id}/download-page). Provide exactly one.

This tool NEVER streams binaries through MCP. ${AGENT_HANDOFF_NOTE}

Args:
  - model_id (number, optional): Rejected if model is not free.
  - url (string, optional): CGTrader product page or /items/{id}/download-page URL.

Returns:
  {
    model_id, model_title, count,
    files: [{ file_id, name, extension, download_url, error? }],
    expires_hint, agent_note
  }
  Per-file failures don't fail the whole call — failed entries carry an 'error' string and a null download_url.`,
      inputSchema: GetFreeModelDownloadUrlsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: GetFreeModelDownloadUrlsInput) => {
      try {
        const modelId = await resolveModelId({
          model_id: params.model_id,
          url: params.url,
        });
        const model = await fetchFreeModelOrThrow(env, modelId);
        const files = model.files ?? [];
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Model ${modelId} has no downloadable files listed.`,
              },
            ],
            structuredContent: {
              model_id: modelId,
              model_title: model.title,
              count: 0,
              files: [],
            },
          };
        }

        const results = await Promise.all(
          files.map(async (f) => {
            try {
              const url = await resolveSignedUrl(env, modelId, f.id);
              return {
                file_id: f.id,
                name: f.name,
                extension: fileExtension(f.name),
                download_url: url as string | null,
                error: null as string | null,
              };
            } catch (err) {
              return {
                file_id: f.id,
                name: f.name,
                extension: fileExtension(f.name),
                download_url: null,
                error:
                  err instanceof Error ? err.message : String(err),
              };
            }
          }),
        );

        const structured = {
          model_id: modelId,
          model_title: model.title,
          count: results.length,
          files: results,
          expires_hint: EXPIRES_HINT,
          agent_note: AGENT_HANDOFF_NOTE,
        };

        const title = model.title ?? `model ${modelId}`;
        const lines: string[] = [];
        lines.push(`# Download links — ${title}`);
        lines.push("");
        lines.push(`${results.length} file(s). ${EXPIRES_HINT}`);
        lines.push("");
        for (const r of results) {
          const label = fileLabel({ name: r.name, id: r.file_id });
          if (r.download_url) {
            lines.push(`- [${label}](${r.download_url})`);
          } else {
            lines.push(`- ${label} — _unavailable: ${r.error}_`);
          }
        }
        lines.push("");
        lines.push(`> ${AGENT_HANDOFF_NOTE}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: structured,
        };
      } catch (error) {
        if (error instanceof FreeOnlyViolation) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        if (error instanceof UrlResolutionError) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

// ─── preview_model_3d (UI + URL→id resolution) ───────────────────────────────

const PreviewModelInputSchema = z
  .object({
    model_id: modelIdField.optional(),
    url: modelUrlField.optional(),
  })
  .strict();

type PreviewModelInput = z.infer<typeof PreviewModelInputSchema>;

export type PreviewCandidate = {
  file_id: number;
  name: string | undefined;
  extension: ViewerExtension;
};

export type PreviewResult = {
  model_id: number;
  model_title: string | undefined;
  model_url: string | undefined;
  picked:
    | (PreviewCandidate & {
        download_url: string;
        expires_hint: string;
      })
    | null;
  candidates: PreviewCandidate[];
  unsupported_extensions: string[];
};

function selectPreviewCandidates(
  files: Array<{ id: number; name?: string }>,
): { candidates: PreviewCandidate[]; unsupported: string[] } {
  const unsupported: string[] = [];
  const byExt: Record<ViewerExtension, PreviewCandidate[]> = {
    glb: [],
    fbx: [],
    obj: [],
    stl: [],
    gltf: [],
  };
  for (const f of files) {
    const ext = fileExtension(f.name);
    if (!ext) continue;
    if (VIEWER_EXTENSION_SET.has(ext)) {
      byExt[ext as ViewerExtension].push({
        file_id: f.id,
        name: f.name,
        extension: ext as ViewerExtension,
      });
    } else {
      unsupported.push(ext);
    }
  }
  const candidates: PreviewCandidate[] = [];
  for (const ext of VIEWER_PREFERRED_EXTENSIONS) {
    candidates.push(...byExt[ext]);
  }
  return {
    candidates,
    unsupported: Array.from(new Set(unsupported)),
  };
}

function registerPreviewModel3d(server: McpServer, env: Env) {
  registerAppTool(
    server,
    "cgtrader_preview_model_3d",
    {
      title: "Preview a free CGTrader model in 3D",
      _meta: { ui: { resourceUri: MODEL_PREVIEW_UI_RESOURCE_URI } },
      description: `Open an interactive 3D preview of a FREE CGTrader model, rendered in the host with @cgtrader/cgt-viewer (WebGPU/WebGL).

Accepts either a numeric model_id OR a CGTrader URL (product page, e.g. /free-3d-models/..., or /items/{id}/download-page). Product-page URLs resolve via JSON-LD Product.sku scraping; /items/{id} URLs read the id from the path.

Supported render formats: glb, fbx, obj, stl, gltf. The tool auto-picks the first available file in that preference order; the UI lets the user switch among candidates. Models that ship only in non-web formats (.blend, .max, .3ds, …) are returned with picked=null and a list of unsupported_extensions so the UI can explain the gap.

Rejects if the model is not free.

Args:
  - model_id (number, optional): Numeric CGTrader model id.
  - url (string, optional): CGTrader product page or /items/{id}/download-page URL.
  (Provide exactly one.)

Returns: { model_id, model_title, model_url, picked: { file_id, name, extension, download_url, expires_hint } | null, candidates: [{ file_id, name, extension }], unsupported_extensions: [string] }.`,
      inputSchema: PreviewModelInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: PreviewModelInput) => {
      try {
        const modelId = await resolveModelId({
          model_id: params.model_id,
          url: params.url,
        });

        const model = await fetchFreeModelOrThrow(env, modelId);
        const { candidates, unsupported } = selectPreviewCandidates(
          model.files ?? [],
        );

        let picked: PreviewResult["picked"] = null;
        if (candidates.length > 0) {
          const first = candidates[0]!;
          const url = await resolveSignedUrl(env, modelId, first.file_id);
          picked = {
            ...first,
            download_url: url,
            expires_hint: EXPIRES_HINT,
          };
        }

        const structured: PreviewResult = {
          model_id: modelId,
          model_title: model.title,
          model_url: model.url,
          picked,
          candidates,
          unsupported_extensions: unsupported,
        };

        const title = model.title ?? `model ${modelId}`;
        const lines: string[] = [];
        lines.push(`# 3D preview — ${title}`);
        lines.push("");
        if (picked) {
          lines.push(
            `Loaded \`${picked.name ?? `file ${picked.file_id}`}\` (${picked.extension}). ${candidates.length} candidate file${candidates.length === 1 ? "" : "s"} available.`,
          );
        } else if (unsupported.length > 0) {
          lines.push(
            `No web-previewable file found. Model ships as: ${unsupported.join(", ")}. Download and open in a native DCC tool.`,
          );
        } else {
          lines.push(`No files are attached to model ${modelId}.`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (error instanceof FreeOnlyViolation) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        if (error instanceof UrlResolutionError) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

export function registerModelTools(server: McpServer, env: Env) {
  registerSearchUiResource(server);
  registerModelDetailUiResource(server);
  registerModelPreviewUiResource(server);
  registerSearchModels(server, env);
  registerGetModel(server, env);
  registerViewModel(server, env);
  registerGetModelImages(server, env);
  registerGetModelLicense(server, env);
  registerDownloadFreeFile(server, env);
  registerGetFreeModelDownloadUrls(server, env);
  registerPreviewModel3d(server, env);
}
