import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./styles.css";

type Model = {
  id: number;
  title?: string;
  author_name?: string;
  url?: string;
  thumbnails?: string[];
  availableFileExtensions?: string[];
  animated?: boolean;
  rigged?: boolean;
  game_ready?: boolean;
};

type SearchResult = {
  total?: number;
  count?: number;
  page?: number;
  per_page?: number;
  has_more?: boolean;
  next_page?: number | null;
  models?: Model[];
};

const root = document.getElementById("app")!;
const summaryEl = document.getElementById("summary")!;
const gridEl = document.getElementById("grid")!;
const pagerEl = document.getElementById("pager")!;
const pageLabelEl = document.getElementById("page-label")!;
const prevBtn = document.getElementById("prev-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;

let lastArgs: Record<string, unknown> = {};
let currentResult: SearchResult | null = null;
let displayMode: "inline" | "fullscreen" | string = "inline";

function pickThumb(m: Model): string | undefined {
  return m.thumbnails?.find((t) => typeof t === "string" && t.length > 0);
}

function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function makeChip(label: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = label;
  return span;
}

function makeCard(m: Model): HTMLElement {
  const href =
    safeHttpUrl(m.url) ??
    `https://www.cgtrader.com/3d-models/${Number(m.id) || 0}`;
  const a = document.createElement("a");
  a.className = "card";
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";

  const thumb = safeHttpUrl(pickThumb(m));
  if (thumb) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.alt = "";
    img.src = thumb;
    a.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "thumb";
    a.appendChild(ph);
  }

  const body = document.createElement("div");
  body.className = "card-body";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = m.title ?? `Model ${m.id}`;
  body.appendChild(title);

  if (m.author_name) {
    const author = document.createElement("div");
    author.className = "author";
    author.textContent = `by ${m.author_name}`;
    body.appendChild(author);
  }

  const chips: HTMLElement[] = [];
  if (m.animated) chips.push(makeChip("Animated"));
  if (m.rigged) chips.push(makeChip("Rigged"));
  if (m.game_ready) chips.push(makeChip("Game-ready"));
  for (const ext of (m.availableFileExtensions ?? []).slice(0, 3)) {
    chips.push(makeChip(ext));
  }
  if (chips.length) {
    const chipWrap = document.createElement("div");
    chipWrap.className = "chips";
    for (const c of chips) chipWrap.appendChild(c);
    body.appendChild(chipWrap);
  }

  a.appendChild(body);
  return a;
}

function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function render(result: SearchResult): void {
  currentResult = result;
  const models = result.models ?? [];
  const page = result.page ?? 1;
  const total = result.total ?? 0;
  const perPage = result.per_page ?? 25;

  summaryEl.textContent =
    models.length === 0
      ? "No results"
      : `${total.toLocaleString()} free models — page ${page}`;

  clearChildren(gridEl);
  if (models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No free models match these filters.";
    gridEl.appendChild(empty);
  } else {
    for (const m of models) gridEl.appendChild(makeCard(m));
  }

  const hasPrev = page > 1;
  const hasNext =
    result.has_more === true || (result.next_page ?? null) !== null;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  pagerEl.hidden = !hasPrev && !hasNext;
  prevBtn.disabled = !hasPrev;
  nextBtn.disabled = !hasNext;
  pageLabelEl.textContent = `Page ${page} of ${pageCount}`;
}

async function gotoPage(page: number): Promise<void> {
  root.classList.add("loading");
  try {
    const result = await app.callServerTool({
      name: "cgtrader_search_models",
      arguments: { ...lastArgs, page, response_format: "json" },
    });
    const structured = result.structuredContent as SearchResult | undefined;
    if (structured) {
      lastArgs = { ...lastArgs, page };
      render(structured);
    }
  } catch (e) {
    console.error("pagination failed", e);
  } finally {
    root.classList.remove("loading");
  }
}

function handleHostContextChanged(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    root.style.paddingTop = `${top + 12}px`;
    root.style.paddingRight = `${right + 12}px`;
    root.style.paddingBottom = `${bottom + 12}px`;
    root.style.paddingLeft = `${left + 12}px`;
  }
  if (ctx.availableDisplayModes?.includes("fullscreen")) {
    fullscreenBtn.hidden = false;
  }
  if (ctx.displayMode) {
    displayMode = ctx.displayMode;
    fullscreenBtn.textContent =
      displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
  }
}

const app = new App({ name: "CGTrader Search", version: "0.1.0" });

app.onhostcontextchanged = handleHostContextChanged;

app.ontoolinput = (params) => {
  lastArgs = { ...(params.arguments as Record<string, unknown>) };
  summaryEl.textContent = "Searching CGTrader…";
  clearChildren(gridEl);
};

app.ontoolresult = (result: CallToolResult) => {
  const structured = result.structuredContent as SearchResult | undefined;
  if (structured) {
    render(structured);
  } else {
    summaryEl.textContent = "No structured result.";
  }
};

app.onerror = console.error;

prevBtn.addEventListener("click", () => {
  const page = currentResult?.page ?? 1;
  if (page > 1) void gotoPage(page - 1);
});
nextBtn.addEventListener("click", () => {
  const next = currentResult?.next_page ?? (currentResult?.page ?? 1) + 1;
  void gotoPage(next);
});
fullscreenBtn.addEventListener("click", async () => {
  const target = displayMode === "fullscreen" ? "inline" : "fullscreen";
  try {
    const res = await app.requestDisplayMode({ mode: target });
    displayMode = res.mode;
    fullscreenBtn.textContent =
      displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
  } catch (e) {
    console.error("display-mode toggle failed", e);
  }
});

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) handleHostContextChanged(ctx);
});
