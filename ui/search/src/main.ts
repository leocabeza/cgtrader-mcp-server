import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clearChildren, makeChip, safeHttpUrl } from "../../shared/dom.ts";
import { applyHostContext } from "../../shared/host-context.ts";
import {
  renderModelDetail,
  type ModelDetailHandle,
} from "../../shared/model-detail.ts";
import type { Model, ViewModelResult } from "../../shared/types.ts";
import "./styles.css";

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
const backBtn = document.getElementById("back-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;
const loaderEl = document.getElementById("loader") as HTMLElement;
const detailContainerEl = document.getElementById(
  "detail-container",
) as HTMLElement;

const loaderLabelEl = loaderEl.querySelector(".loader-label") as HTMLElement;
const DEFAULT_LOADER_LABEL = loaderLabelEl.textContent ?? "Loading…";

let lastArgs: Record<string, unknown> = {};
let currentResult: SearchResult | null = null;
let displayMode: "inline" | "fullscreen" | string = "inline";
let detailHandle: ModelDetailHandle | null = null;
let lastSummary = "";

function setLoading(on: boolean, label?: string): void {
  root.classList.toggle("loading", on);
  loaderEl.hidden = !on;
  loaderLabelEl.textContent = on ? label ?? DEFAULT_LOADER_LABEL : DEFAULT_LOADER_LABEL;
}

function pickThumb(m: Model): string | undefined {
  return m.thumbnails?.find((t) => typeof t === "string" && t.length > 0);
}

function makeCard(m: Model): HTMLElement {
  const externalHref =
    safeHttpUrl(m.url) ??
    `https://www.cgtrader.com/3d-models/${Number(m.id) || 0}`;

  const card = document.createElement("button");
  card.type = "button";
  card.className = "card";
  card.addEventListener("click", () => openDetail(m));

  const thumb = safeHttpUrl(pickThumb(m));
  if (thumb) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.alt = "";
    img.src = thumb;
    card.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "thumb";
    card.appendChild(ph);
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

  const footer = document.createElement("div");
  footer.className = "card-footer";
  const external = document.createElement("span");
  external.className = "external-link";
  external.textContent = "See on CGTrader ↗";
  external.addEventListener("click", (e) => {
    e.stopPropagation();
    void app
      .openLink({ url: externalHref })
      .catch((err) => console.error("openLink failed", err));
  });
  footer.appendChild(external);
  body.appendChild(footer);

  card.appendChild(body);
  return card;
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
  lastSummary = summaryEl.textContent;

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
  setLoading(true);
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
    setLoading(false);
  }
}

function showGrid(): void {
  detailHandle?.destroy();
  detailHandle = null;
  clearChildren(detailContainerEl);
  detailContainerEl.hidden = true;

  gridEl.hidden = false;
  pagerEl.hidden = !currentResult
    ? true
    : !(
        (currentResult.page ?? 1) > 1 ||
        currentResult.has_more === true ||
        (currentResult.next_page ?? null) !== null
      );
  backBtn.hidden = true;
  summaryEl.textContent = lastSummary;
}

function showDetail(): void {
  gridEl.hidden = true;
  pagerEl.hidden = true;
  detailContainerEl.hidden = false;
  backBtn.hidden = false;
}

async function openDetail(m: Model): Promise<void> {
  const title = m.title ?? `model ${m.id}`;
  showDetail();
  clearChildren(detailContainerEl);
  detailContainerEl.classList.remove("detail");
  setLoading(true, `Opening "${title}"…`);

  try {
    const res = await app.callServerTool({
      name: "cgtrader_view_model",
      arguments: { model_id: m.id },
    });
    const structured = res.structuredContent as ViewModelResult | undefined;
    if (!structured?.model) {
      summaryEl.textContent =
        res.isError && res.content?.[0]?.type === "text"
          ? (res.content[0] as { text: string }).text
          : "Couldn't load model details.";
      return;
    }
    detailHandle = renderModelDetail(detailContainerEl, structured, {
      callServerTool: (p) => app.callServerTool(p),
      openLink: (p) => app.openLink(p),
    });
    summaryEl.textContent = `Free model · id ${structured.model.id}`;
  } catch (e) {
    console.error("cgtrader_view_model failed", e);
    summaryEl.textContent =
      e instanceof Error ? e.message : "Couldn't load model details.";
  } finally {
    setLoading(false);
  }
}

const app = new App({ name: "CGTrader Search", version: "0.1.0" });

app.onhostcontextchanged = (ctx) => {
  applyHostContext(root, ctx, {
    fullscreenBtn,
    onDisplayMode: (m) => {
      displayMode = m;
    },
  });
};

app.ontoolinput = (params) => {
  showGrid();
  lastArgs = { ...(params.arguments as Record<string, unknown>) };
  summaryEl.textContent = "Searching CGTrader…";
  clearChildren(gridEl);
  setLoading(true);
};

app.ontoolresult = (result: CallToolResult) => {
  setLoading(false);
  const structured = result.structuredContent as SearchResult | undefined;
  if (structured) {
    render(structured);
  } else {
    summaryEl.textContent = "No structured result.";
  }
};

app.onerror = (e) => {
  setLoading(false);
  console.error(e);
};

prevBtn.addEventListener("click", () => {
  const page = currentResult?.page ?? 1;
  if (page > 1) void gotoPage(page - 1);
});
nextBtn.addEventListener("click", () => {
  const next = currentResult?.next_page ?? (currentResult?.page ?? 1) + 1;
  void gotoPage(next);
});
backBtn.addEventListener("click", () => showGrid());
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
  if (ctx) {
    applyHostContext(root, ctx, {
      fullscreenBtn,
      onDisplayMode: (m) => {
        displayMode = m;
      },
    });
  }
});
