import { CHARACTER_LIMIT } from "../constants.js";
import { CGTraderModel, ResponseFormat } from "../types.js";

export function modelSummaryLine(m: CGTraderModel): string {
  const title = m.title ?? `Model ${m.id}`;
  const author = m.author_name ? ` by ${m.author_name}` : "";
  const tags =
    m.tags && m.tags.length > 0 ? ` — tags: ${m.tags.slice(0, 5).join(", ")}` : "";
  return `- **${title}** (id: ${m.id})${author}${tags}`;
}

export function modelsToMarkdown(
  title: string,
  models: CGTraderModel[],
  pagination: { page: number; per_page: number; total: number; has_more: boolean },
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `Page ${pagination.page} — showing ${models.length} of ${pagination.total} total${pagination.has_more ? " (more available)" : ""}.`,
  );
  lines.push("");
  if (models.length === 0) {
    lines.push("_No matching free models found._");
    return lines.join("\n");
  }
  for (const m of models) lines.push(modelSummaryLine(m));
  return lines.join("\n");
}

export function truncateIfNeeded(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };
  const suffix = `\n\n…response truncated at ${CHARACTER_LIMIT} characters. Narrow filters or reduce per_page.`;
  return {
    text: text.slice(0, CHARACTER_LIMIT - suffix.length) + suffix,
    truncated: true,
  };
}

export function renderText(
  format: ResponseFormat,
  markdown: string,
  structured: unknown,
): string {
  const raw =
    format === ResponseFormat.MARKDOWN
      ? markdown
      : JSON.stringify(structured, null, 2);
  return truncateIfNeeded(raw).text;
}
