import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./styles.css";

type Image = {
  id?: number;
  url?: string;
  width?: number;
  height?: number;
};

type File = {
  id: number;
  name?: string;
};

type Model = {
  id: number;
  title?: string;
  author_name?: string;
  url?: string;
  category_id?: number;
  subcategory_id?: number;
  description?: string;
  tags?: string[];
  prices?: { download?: number };
  files?: File[];
  availableFileExtensions?: string[];
  thumbnails?: string[];
  animated?: boolean;
  rigged?: boolean;
  game_ready?: boolean;
  license?: string;
};

type ViewModelResult = {
  model: Model;
  images: Image[];
};

type DownloadEntry = {
  file_id: number;
  name?: string;
  extension?: string | null;
  download_url: string | null;
  error: string | null;
};

type DownloadResult = {
  model_id: number;
  model_title?: string;
  count: number;
  files: DownloadEntry[];
  expires_hint?: string;
  agent_note?: string;
};

const root = document.getElementById("app")!;
const summaryEl = document.getElementById("summary")!;
const detailEl = document.getElementById("detail") as HTMLElement;
const loaderEl = document.getElementById("loader") as HTMLElement;
const heroEl = document.getElementById("hero") as HTMLImageElement;
const heroPrev = document.getElementById("hero-prev") as HTMLButtonElement;
const heroNext = document.getElementById("hero-next") as HTMLButtonElement;
const thumbStripEl = document.getElementById("thumb-strip")!;
const titleEl = document.getElementById("title")!;
const authorEl = document.getElementById("author")!;
const chipsEl = document.getElementById("chips")!;
const factsEl = document.getElementById("facts")!;
const descriptionEl = document.getElementById("description") as HTMLElement;
const descriptionBodyEl = document.getElementById("description-body")!;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const externalBtn = document.getElementById("external-btn") as HTMLButtonElement;
const downloadsEl = document.getElementById("downloads") as HTMLElement;
const downloadListEl = document.getElementById("download-list")!;
const downloadHintEl = document.getElementById("download-hint")!;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;

let currentModel: Model | null = null;
let galleryUrls: string[] = [];
let galleryIndex = 0;
let displayMode: "inline" | "fullscreen" | string = "inline";

function setLoading(on: boolean): void {
  loaderEl.hidden = !on;
  detailEl.hidden = on;
}

function safeHttpUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeChip(label: string, variant?: "free"): HTMLElement {
  const span = document.createElement("span");
  span.className = variant ? `chip ${variant}` : "chip";
  span.textContent = label;
  return span;
}

function buildGalleryUrls(model: Model, images: Image[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const img of images) {
    const u = safeHttpUrl(img.url);
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  for (const t of model.thumbnails ?? []) {
    const u = safeHttpUrl(t);
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls;
}

function renderGallery(): void {
  if (galleryUrls.length === 0) {
    heroEl.removeAttribute("src");
    heroEl.alt = "No preview images";
    heroPrev.disabled = true;
    heroNext.disabled = true;
    clearChildren(thumbStripEl);
    return;
  }
  galleryIndex = Math.max(0, Math.min(galleryIndex, galleryUrls.length - 1));
  heroEl.src = galleryUrls[galleryIndex];
  heroEl.alt = currentModel?.title
    ? `${currentModel.title} — preview ${galleryIndex + 1}`
    : `Preview ${galleryIndex + 1}`;
  heroPrev.disabled = galleryIndex === 0;
  heroNext.disabled = galleryIndex === galleryUrls.length - 1;

  clearChildren(thumbStripEl);
  galleryUrls.forEach((url, i) => {
    const t = document.createElement("img");
    t.src = url;
    t.loading = "lazy";
    t.alt = "";
    if (i === galleryIndex) t.classList.add("active");
    t.addEventListener("click", () => {
      galleryIndex = i;
      renderGallery();
    });
    thumbStripEl.appendChild(t);
  });
}

function addFact(key: string, value: string | number | undefined): void {
  if (value === undefined || value === null || value === "") return;
  const dt = document.createElement("dt");
  dt.textContent = key;
  const dd = document.createElement("dd");
  dd.textContent = String(value);
  factsEl.appendChild(dt);
  factsEl.appendChild(dd);
}

function render(result: ViewModelResult): void {
  currentModel = result.model;
  const m = result.model;

  summaryEl.textContent = `Free model · id ${m.id}`;

  titleEl.textContent = m.title ?? `Model ${m.id}`;
  authorEl.textContent = m.author_name ? `by ${m.author_name}` : "";

  clearChildren(chipsEl);
  chipsEl.appendChild(makeChip("Free", "free"));
  if (m.animated) chipsEl.appendChild(makeChip("Animated"));
  if (m.rigged) chipsEl.appendChild(makeChip("Rigged"));
  if (m.game_ready) chipsEl.appendChild(makeChip("Game-ready"));
  for (const ext of (m.availableFileExtensions ?? []).slice(0, 6)) {
    chipsEl.appendChild(makeChip(ext));
  }

  clearChildren(factsEl);
  if (m.license) addFact("License", m.license);
  if (m.category_id !== undefined) addFact("Category id", m.category_id);
  if (m.files?.length) addFact("Files", m.files.length);
  if (m.tags?.length) addFact("Tags", m.tags.slice(0, 12).join(", "));

  if (m.description && m.description.trim() !== "") {
    descriptionBodyEl.textContent = m.description;
    descriptionEl.hidden = false;
  } else {
    descriptionEl.hidden = true;
  }

  galleryUrls = buildGalleryUrls(m, result.images ?? []);
  galleryIndex = 0;
  renderGallery();

  downloadBtn.disabled = !(m.files && m.files.length > 0);
  downloadsEl.hidden = true;
  clearChildren(downloadListEl);
  downloadHintEl.textContent = "";
}

function renderDownloads(data: DownloadResult): void {
  clearChildren(downloadListEl);
  for (const f of data.files) {
    const li = document.createElement("li");
    const label = f.name ?? `file ${f.file_id}`;
    if (f.download_url) {
      const a = document.createElement("a");
      a.href = f.download_url;
      a.textContent = label;
      a.target = "_blank";
      a.rel = "noreferrer noopener";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void app
          .openLink({ url: f.download_url! })
          .catch((err) => console.error("openLink failed", err));
      });
      li.appendChild(a);
    } else {
      li.className = "failed";
      li.textContent = `${label} — unavailable${f.error ? `: ${f.error}` : ""}`;
    }
    downloadListEl.appendChild(li);
  }
  downloadHintEl.textContent = data.expires_hint ?? "";
  downloadsEl.hidden = data.files.length === 0;
}

function showError(message: string): void {
  setLoading(false);
  detailEl.hidden = true;
  const existing = root.querySelector(".error");
  if (existing) existing.remove();
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = message;
  root.appendChild(box);
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

const app = new App({ name: "CGTrader Model Detail", version: "0.1.0" });

app.onhostcontextchanged = handleHostContextChanged;

app.ontoolinput = () => {
  setLoading(true);
  summaryEl.textContent = "Loading model…";
};

app.ontoolresult = (result: CallToolResult) => {
  setLoading(false);
  const structured = result.structuredContent as
    | (ViewModelResult & { error?: string })
    | undefined;
  if (!structured || !structured.model) {
    showError(
      typeof structured?.error === "string"
        ? structured.error
        : "No model data returned.",
    );
    return;
  }
  render(structured);
};

app.onerror = (e) => {
  setLoading(false);
  console.error(e);
};

heroPrev.addEventListener("click", () => {
  if (galleryIndex > 0) {
    galleryIndex -= 1;
    renderGallery();
  }
});
heroNext.addEventListener("click", () => {
  if (galleryIndex < galleryUrls.length - 1) {
    galleryIndex += 1;
    renderGallery();
  }
});

externalBtn.addEventListener("click", async () => {
  const url =
    safeHttpUrl(currentModel?.url) ??
    `https://www.cgtrader.com/3d-models/${currentModel?.id ?? 0}`;
  try {
    await app.openLink({ url });
  } catch (e) {
    console.error("openLink failed", e);
    window.open(url, "_blank", "noopener,noreferrer");
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!currentModel) return;
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Fetching links…";
  try {
    const res = await app.callServerTool({
      name: "cgtrader_get_free_model_download_urls",
      arguments: { model_id: currentModel.id },
    });
    const data = res.structuredContent as DownloadResult | undefined;
    if (data) {
      renderDownloads(data);
    }
  } catch (e) {
    console.error("download fetch failed", e);
    downloadHintEl.textContent =
      e instanceof Error ? e.message : "Failed to fetch download links.";
    downloadsEl.hidden = false;
  } finally {
    downloadBtn.disabled = !(currentModel?.files && currentModel.files.length > 0);
    downloadBtn.textContent = "Get free download";
  }
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
