import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env.js";
import { CGTraderCategory } from "../types.js";
import { apiGet, handleApiError } from "../services/client.js";
import { elicitForm, type FormSchema } from "../services/elicit.js";
import { renderText } from "../services/format.js";
import { categoryIdField, responseFormatField } from "../schemas/common.js";

const MAX_PICKER_OPTIONS = 20;

function isTopLevel(c: { parent_id?: number | null }): boolean {
  return c.parent_id === undefined || c.parent_id === null;
}

function collectSubtree(
  root: number,
  all: CGTraderCategory[],
): CGTraderCategory[] {
  const childrenOf = new Map<number, CGTraderCategory[]>();
  for (const c of all) {
    const p = c.parent_id;
    if (p === undefined || p === null) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(c);
  }
  const out: CGTraderCategory[] = [];
  const rootNode = all.find((c) => c.id === root);
  if (rootNode) out.push(rootNode);
  const stack = [root];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of childrenOf.get(id) ?? []) {
      out.push(child);
      stack.push(child.id);
    }
  }
  return out;
}

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
        const allCategories: CGTraderCategory[] = Array.isArray(data)
          ? data
          : (data.categories ?? []);

        // Offer a drill-in picker on hosts that support elicitation. User
        // picks a top-level category → we narrow the returned list to that
        // subtree. Decline/unsupported → full list as before.
        const topLevel = allCategories
          .filter(isTopLevel)
          .slice(0, MAX_PICKER_OPTIONS);
        let filtered: CGTraderCategory[] = allCategories;
        let pickedId: number | null = null;
        let userNotes: string | null = null;
        let userDeclined = false;
        if (topLevel.length >= 2) {
          const pickerSchema: FormSchema = {
            type: "object",
            properties: {
              category: {
                type: "string",
                title: "Drill into a category (optional)",
                oneOf: [
                  { const: "all", title: "Show me everything" },
                  ...topLevel.map((c) => ({
                    const: String(c.id),
                    title: c.name ?? `Category ${c.id}`,
                  })),
                ],
                default: "all",
              },
              notes: {
                type: "string",
                title: "Looking for something specific? (optional)",
                description:
                  "Free-text hint for the assistant — e.g. 'actually I want subcategories of cars'.",
              },
            },
          };
          const outcome = await elicitForm<{
            category?: string;
            notes?: string;
          }>(
            server,
            "Browsing CGTrader categories — pick a top-level category to drill into, or 'Show me everything'.",
            pickerSchema,
          );
          if (outcome.status === "accepted") {
            if (
              outcome.values.category &&
              outcome.values.category !== "all"
            ) {
              const id = Number(outcome.values.category);
              if (Number.isFinite(id)) {
                pickedId = id;
                filtered = collectSubtree(id, allCategories);
              }
            }
            const notes = outcome.values.notes;
            if (typeof notes === "string" && notes.trim() !== "") {
              userNotes = notes.trim();
            }
          } else if (outcome.status === "declined") {
            userDeclined = true;
          }
        }

        const structured = {
          count: filtered.length,
          total: allCategories.length,
          category_id: pickedId,
          categories: filtered,
          _user_notes: userNotes,
        };
        const heading = pickedId
          ? `# CGTrader categories under id ${pickedId} (${filtered.length} of ${allCategories.length})`
          : `# CGTrader categories (${filtered.length})`;
        const hintLines: string[] = [];
        if (userNotes) {
          hintLines.push(
            `> **User added a note:** ${userNotes}\n>\n> Take this into account; if the results don't match, ask the user to clarify.`,
          );
        }
        if (userDeclined) {
          hintLines.push(
            "> **User declined the category picker.** If they seem unsatisfied, re-prompt them in natural language to describe what they're looking for.",
          );
        }
        const md = [
          heading,
          "",
          ...filtered.map(
            (c) =>
              `- **${c.name ?? `(unnamed)`}** (id: ${c.id}${c.parent_id ? `, parent: ${c.parent_id}` : ""})${c.slug ? ` — \`${c.slug}\`` : ""}`,
          ),
          ...(hintLines.length ? ["", "---", "", hintLines.join("\n\n")] : []),
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
