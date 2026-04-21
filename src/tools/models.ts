import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CGTraderImage,
  CGTraderLicense,
  CGTraderModel,
  CGTraderModelListResponse,
} from "../types.js";
import { apiGet, apiGetRaw, handleApiError } from "../services/client.js";
import {
  FreeOnlyViolation,
  fetchFreeModelOrThrow,
  isFreeModel,
} from "../services/free-guard.js";
import { modelsToMarkdown, renderText } from "../services/format.js";
import {
  categoryIdField,
  modelIdField,
  pageField,
  perPageField,
  responseFormatField,
} from "../schemas/common.js";

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

function registerSearchModels(server: McpServer) {
  server.registerTool(
    "cgtrader_search_models",
    {
      title: "Search free CGTrader models",
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
        const apiParams: Record<string, unknown> = {
          page: params.page,
          per_page: params.per_page,
          sort: params.sort,
          adult_content: params.adult_content,
          // free-only enforcement:
          min_price: 0,
          max_price: 0,
        };
        if (params.keywords) apiParams.keywords = params.keywords;
        if (params.category_id !== undefined)
          apiParams.category_id = params.category_id;
        if (params.product_type) apiParams.product_type = params.product_type;
        if (params.extensions) apiParams.extensions = params.extensions;
        if (params.polygons) apiParams.polygons = params.polygons;
        if (params.low_poly !== undefined) apiParams.low_poly = params.low_poly;
        if (params.animated !== undefined) apiParams.animated = params.animated;
        if (params.rigged !== undefined) apiParams.rigged = params.rigged;
        if (params.pbr !== undefined) apiParams.pbr = params.pbr;

        const data = await apiGet<CGTraderModelListResponse>(
          "/models",
          apiParams,
        );

        // Defensive: drop anything the API returns that isn't actually free.
        const freeModels = (data.models ?? []).filter(isFreeModel);
        const total = data.total ?? freeModels.length;
        const consumed = params.page * params.per_page;
        const has_more = total > consumed;

        const structured = {
          total,
          count: freeModels.length,
          page: params.page,
          per_page: params.per_page,
          has_more,
          next_page: has_more ? params.page + 1 : null,
          models: freeModels,
        };

        const markdown = modelsToMarkdown("Free model search results", freeModels, {
          page: params.page,
          per_page: params.per_page,
          total,
          has_more,
        });

        const text = renderText(params.response_format, markdown, structured);
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
    model_id: modelIdField,
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

function registerGetModel(server: McpServer) {
  server.registerTool(
    "cgtrader_get_model",
    {
      title: "Get free CGTrader model details",
      description: `Fetch full details for a single CGTrader model by id.

Rejects with an error if the model is not free (download price > 0). Use cgtrader_search_models to find free model ids first.

Args:
  - model_id (number, required): CGTrader model id.
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
        const model = await fetchFreeModelOrThrow(params.model_id);
        const text = renderText(
          params.response_format,
          modelToMarkdown(model),
          model,
        );
        return {
          content: [{ type: "text", text }],
          structuredContent: model as unknown as Record<string, unknown>,
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

// ─── get_model_images ────────────────────────────────────────────────────────

const GetModelImagesInputSchema = z
  .object({
    model_id: modelIdField,
    response_format: responseFormatField,
  })
  .strict();

type GetModelImagesInput = z.infer<typeof GetModelImagesInputSchema>;

function registerGetModelImages(server: McpServer) {
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
        await fetchFreeModelOrThrow(params.model_id);
        const data = await apiGet<{ images?: CGTraderImage[] } | CGTraderImage[]>(
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

function registerGetModelLicense(server: McpServer) {
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
        await fetchFreeModelOrThrow(params.model_id);
        const license = await apiGet<CGTraderLicense>(
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
  modelId: number,
  fileId: number,
): Promise<string> {
  const res = await apiGetRaw(`/models/${modelId}/files/${fileId}`);
  const location =
    (res.headers?.location as string | undefined) ??
    (res.headers?.Location as string | undefined);
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
    model_id: modelIdField,
    file_id: z
      .number()
      .int()
      .positive()
      .describe("CGTrader file id (from model.files[].id)."),
  })
  .strict();

type DownloadFreeFileInput = z.infer<typeof DownloadFreeFileInputSchema>;

function registerDownloadFreeFile(server: McpServer) {
  server.registerTool(
    "cgtrader_download_free_file",
    {
      title: "Get download URL for a free CGTrader model file",
      description: `Resolve a signed download URL for ONE file on a FREE CGTrader model.

When the user wants to download a model with multiple files, prefer cgtrader_get_free_model_download_urls — it returns every file's URL in a single call instead of one call per file.

This tool NEVER streams the binary through MCP. It returns a short-lived S3 signed URL meant for the end user's browser. ${AGENT_HANDOFF_NOTE}

Args:
  - model_id (number, required): Parent model id. Rejected if not free.
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
        const model = await fetchFreeModelOrThrow(params.model_id);
        const fileBelongs = model.files?.some((f) => f.id === params.file_id);
        if (model.files && !fileBelongs) {
          return {
            content: [
              {
                type: "text",
                text: `Error: file_id ${params.file_id} does not belong to model ${params.model_id}. Known file ids: ${model.files.map((f) => f.id).join(", ") || "(none)"}.`,
              },
            ],
            isError: true,
          };
        }

        const url = await resolveSignedUrl(params.model_id, params.file_id);
        const file = model.files?.find((f) => f.id === params.file_id);
        const label = file ? fileLabel(file) : `file ${params.file_id}`;

        const structured = {
          model_id: params.model_id,
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
    model_id: modelIdField,
  })
  .strict();

type GetFreeModelDownloadUrlsInput = z.infer<
  typeof GetFreeModelDownloadUrlsInputSchema
>;

function registerGetFreeModelDownloadUrls(server: McpServer) {
  server.registerTool(
    "cgtrader_get_free_model_download_urls",
    {
      title: "Get all download URLs for a free CGTrader model",
      description: `Resolve signed download URLs for EVERY file attached to a FREE CGTrader model, in a single call.

Prefer this tool over cgtrader_download_free_file whenever the user wants to download a model (they almost always want all the files). It runs the per-file redirect fetches in parallel server-side, so the agent makes ONE tool call instead of N.

This tool NEVER streams binaries through MCP. ${AGENT_HANDOFF_NOTE}

Args:
  - model_id (number, required): Rejected if model is not free.

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
        const model = await fetchFreeModelOrThrow(params.model_id);
        const files = model.files ?? [];
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Model ${params.model_id} has no downloadable files listed.`,
              },
            ],
            structuredContent: {
              model_id: params.model_id,
              model_title: model.title,
              count: 0,
              files: [],
            },
          };
        }

        const results = await Promise.all(
          files.map(async (f) => {
            try {
              const url = await resolveSignedUrl(params.model_id, f.id);
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
          model_id: params.model_id,
          model_title: model.title,
          count: results.length,
          files: results,
          expires_hint: EXPIRES_HINT,
          agent_note: AGENT_HANDOFF_NOTE,
        };

        const title = model.title ?? `model ${params.model_id}`;
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
        return {
          content: [{ type: "text", text: handleApiError(error) }],
          isError: true,
        };
      }
    },
  );
}

export function registerModelTools(server: McpServer) {
  registerSearchModels(server);
  registerGetModel(server);
  registerGetModelImages(server);
  registerGetModelLicense(server);
  registerDownloadFreeFile(server);
  registerGetFreeModelDownloadUrls(server);
}
