import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env.js";
import { CGTraderCategory } from "../types.js";
import { apiGet, handleApiError } from "../services/client.js";
import { renderText } from "../services/format.js";
import { categoryIdField, responseFormatField } from "../schemas/common.js";

const ListCategoriesInputSchema = z
  .object({
    response_format: responseFormatField,
  })
  .strict();

type ListCategoriesInput = z.infer<typeof ListCategoriesInputSchema>;

function registerListCategories(server: McpServer, env: Env) {
  server.registerTool(
    "cgtrader_list_categories",
    {
      title: "List all CGTrader categories",
      description: `Fetch the full CGTrader category taxonomy.

Use this to discover category ids to pass to cgtrader_search_models.

Args:
  - response_format ('markdown' | 'json', default 'markdown').

Returns: { count, categories: [{ id, name, slug, parent_id, ... }] }.`,
      inputSchema: ListCategoriesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListCategoriesInput) => {
      try {
        const data = await apiGet<
          { categories?: CGTraderCategory[] } | CGTraderCategory[]
        >(env, "/categories");
        const categories: CGTraderCategory[] = Array.isArray(data)
          ? data
          : (data.categories ?? []);
        const structured = { count: categories.length, categories };
        const md = [
          `# CGTrader categories (${categories.length})`,
          "",
          ...categories.map(
            (c) =>
              `- **${c.name ?? `(unnamed)`}** (id: ${c.id}${c.parent_id ? `, parent: ${c.parent_id}` : ""})${c.slug ? ` — \`${c.slug}\`` : ""}`,
          ),
        ].join("\n");
        const text = renderText(params.response_format, md, structured);
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

const GetCategoryInputSchema = z
  .object({
    category_id: categoryIdField,
    response_format: responseFormatField,
  })
  .strict();

type GetCategoryInput = z.infer<typeof GetCategoryInputSchema>;

function registerGetCategory(server: McpServer, env: Env) {
  server.registerTool(
    "cgtrader_get_category",
    {
      title: "Get a CGTrader category by id",
      description: `Fetch a single category's description and metadata.

Args:
  - category_id (number, required).
  - response_format ('markdown' | 'json', default 'markdown').

Returns: the full category object (id, name, slug, parent_id, description, ...).`,
      inputSchema: GetCategoryInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetCategoryInput) => {
      try {
        const data = await apiGet<
          { category?: CGTraderCategory } | CGTraderCategory
        >(env, `/categories/${params.category_id}`);
        const category: CGTraderCategory =
          (data as { category?: CGTraderCategory }).category ??
          (data as CGTraderCategory);
        const md = [
          `# ${category.name ?? `Category ${category.id}`} (id: ${category.id})`,
          "",
          category.slug ? `**Slug:** \`${category.slug}\`` : "",
          category.parent_id ? `**Parent id:** ${category.parent_id}` : "",
          "",
          category.description ?? "",
        ]
          .filter(Boolean)
          .join("\n");
        const text = renderText(params.response_format, md, category);
        return {
          content: [{ type: "text", text }],
          structuredContent: category as unknown as Record<string, unknown>,
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

export function registerCategoryTools(server: McpServer, env: Env) {
  registerListCategories(server, env);
  registerGetCategory(server, env);
}
