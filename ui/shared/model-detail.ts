import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clearChildren, makeChip, safeHttpUrl } from "./dom.ts";
import type {
  DownloadResult,
  Image,
  Model,
  PreviewResult,
  ViewModelResult,
} from "./types.ts";
import "./model-detail.css";

// Formats @cgtrader/cgt-viewer can render in-browser. Must mirror
// VIEWER_PREFERRED_EXTENSIONS in src/tools/models.ts.
const VIEWER_EXTENSIONS: ReadonlySet<string> = new Set([
  "glb",
  "fbx",
  "obj",
  "stl",
  "gltf",
]);

function hasPreviewableExtension(model: Model): boolean {
  const exts = model.availableFileExtensions ?? [];
  return exts.some((e) => VIEWER_EXTENSIONS.has(e.toLowerCase()));
}

/** Disposer callback returned by a preview mount. */
export type PreviewDisposer = () => void;

/**
 * Callback that mounts a 3D preview inside the supplied container and returns
 * a disposer. Kept as a dep (rather than importing mountPreview directly)
 * so bundles that embed model-detail without the viewer — e.g. the search
 * grid — don't pay the three.js cost.
 */
export type PreviewMounter = (args: {
  container: HTMLElement;
  data: PreviewResult;
  onStatus: (msg: string) => void;
}) => Promise<PreviewDisposer>;

export type ModelDetailDeps = {
  callServerTool: (
    params: CallToolRequest["params"],
  ) => Promise<CallToolResult>;
  openLink: (params: { url: string }) => Promise<unknown>;
  /**
   * Optional. When supplied, the detail view shows a "See preview" CTA that
   * mounts an inline 3D viewer via this callback. Omit to hide the CTA —
   * useful for bundles that embed model-detail but don't want the viewer's
   * byte cost (e.g. the search grid).
   */
  mountPreview?: PreviewMounter;
};

export type ModelDetailHandle = {
  /** Tear down listeners; caller should clear the container itself if desired. */
  destroy: () => void;
};

/**
 * Builds the model-detail DOM inside `container` (any previous children are
 * removed) and wires the CTAs using the supplied deps. Returns a handle so
 * callers can dispose of it when swapping views.
 *
 * Deps (callServerTool, openLink) typically come from an `App` instance —
 * passing them in rather than importing the App keeps this module usable from
 * either the standalone detail UI or an overlay inside another UI.
 */
export function renderModelDetail(
  container: HTMLElement,
  data: ViewModelResult,
  deps: ModelDetailDeps,
): ModelDetailHandle {
  clearChildren(container);
  container.classList.add("detail");

  const model = data.model;
  const images = data.images ?? [];

  // ── gallery ───────────────────────────────────────────────────────────
  const gallery = document.createElement("div");
  gallery.className = "gallery";

  const galleryMain = document.createElement("div");
  galleryMain.className = "gallery-main";

  const hero = document.createElement("img");
  hero.className = "hero";
  hero.alt = "";
  galleryMain.appendChild(hero);

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "nav-btn prev";
  prevBtn.setAttribute("aria-label", "Previous image");
  prevBtn.textContent = "‹";
  galleryMain.appendChild(prevBtn);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "nav-btn next";
  nextBtn.setAttribute("aria-label", "Next image");
  nextBtn.textContent = "›";
  galleryMain.appendChild(nextBtn);

  const thumbStrip = document.createElement("div");
  thumbStrip.className = "thumb-strip";

  gallery.appendChild(galleryMain);
  gallery.appendChild(thumbStrip);

  const galleryUrls = buildGalleryUrls(model, images);
  let galleryIndex = 0;

  const renderGallery = (): void => {
    if (galleryUrls.length === 0) {
      hero.removeAttribute("src");
      hero.alt = "No preview images";
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      clearChildren(thumbStrip);
      return;
    }
    galleryIndex = Math.max(0, Math.min(galleryIndex, galleryUrls.length - 1));
    hero.src = galleryUrls[galleryIndex];
    hero.alt = model.title
      ? `${model.title} — preview ${galleryIndex + 1}`
      : `Preview ${galleryIndex + 1}`;
    prevBtn.disabled = galleryIndex === 0;
    nextBtn.disabled = galleryIndex === galleryUrls.length - 1;

    clearChildren(thumbStrip);
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
      thumbStrip.appendChild(t);
    });
  };

  const onPrev = (): void => {
    if (galleryIndex > 0) {
      galleryIndex -= 1;
      renderGallery();
    }
  };
  const onNext = (): void => {
    if (galleryIndex < galleryUrls.length - 1) {
      galleryIndex += 1;
      renderGallery();
    }
  };
  prevBtn.addEventListener("click", onPrev);
  nextBtn.addEventListener("click", onNext);

  // ── meta ──────────────────────────────────────────────────────────────
  const meta = document.createElement("div");
  meta.className = "meta";

  const title = document.createElement("h1");
  title.className = "title";
  title.textContent = model.title ?? `Model ${model.id}`;
  meta.appendChild(title);

  if (model.author_name) {
    const author = document.createElement("div");
    author.className = "author";
    author.textContent = `by ${model.author_name}`;
    meta.appendChild(author);
  }

  const chips = document.createElement("div");
  chips.className = "chips";
  chips.appendChild(makeChip("Free", "free"));
  if (model.animated) chips.appendChild(makeChip("Animated"));
  if (model.rigged) chips.appendChild(makeChip("Rigged"));
  if (model.game_ready) chips.appendChild(makeChip("Game-ready"));
  for (const ext of (model.availableFileExtensions ?? []).slice(0, 6)) {
    chips.appendChild(makeChip(ext));
  }
  meta.appendChild(chips);

  const facts = document.createElement("dl");
  facts.className = "facts";
  const addFact = (key: string, value: string | number | undefined): void => {
    if (value === undefined || value === null || value === "") return;
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    facts.appendChild(dt);
    facts.appendChild(dd);
  };
  if (model.license) addFact("License", licenseLabel(model.license));
  if (model.category_id !== undefined) addFact("Category id", model.category_id);
  if (model.files?.length) addFact("Files", model.files.length);
  if (model.tags?.length) addFact("Tags", model.tags.slice(0, 12).join(", "));
  meta.appendChild(facts);

  // ── CTAs ──────────────────────────────────────────────────────────────
  const ctaRow = document.createElement("div");
  ctaRow.className = "cta-row";

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "cta primary";
  downloadBtn.textContent = "Get free download";
  downloadBtn.disabled = !(model.files && model.files.length > 0);
  ctaRow.appendChild(downloadBtn);

  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "cta secondary";
  previewBtn.textContent = "See preview";
  const canPreview = hasPreviewableExtension(model) && !!deps.mountPreview;
  previewBtn.disabled = !canPreview;
  if (!deps.mountPreview) {
    // Host bundle opted out of the viewer (e.g. the search grid keeps its
    // bundle lean). Hide the CTA entirely rather than showing a dead button.
    previewBtn.hidden = true;
  } else if (!canPreview) {
    previewBtn.title =
      "No web-viewable file on this model (needs glb, fbx, obj, stl, or gltf).";
  }
  ctaRow.appendChild(previewBtn);

  const externalBtn = document.createElement("button");
  externalBtn.type = "button";
  externalBtn.className = "cta secondary";
  externalBtn.textContent = "See on CGTrader";
  ctaRow.appendChild(externalBtn);

  meta.appendChild(ctaRow);

  // ── preview panel (hidden until user clicks "See preview") ────────────
  const previewSection = document.createElement("section");
  previewSection.className = "preview-panel";
  previewSection.hidden = true;
  const previewHeader = document.createElement("div");
  previewHeader.className = "preview-header";
  const previewTitle = document.createElement("div");
  previewTitle.className = "preview-title";
  previewTitle.textContent = "3D preview";
  const previewStatus = document.createElement("div");
  previewStatus.className = "preview-status";
  const previewBackBtn = document.createElement("button");
  previewBackBtn.type = "button";
  previewBackBtn.className = "cta secondary";
  previewBackBtn.textContent = "Close preview";
  previewHeader.appendChild(previewTitle);
  previewHeader.appendChild(previewStatus);
  previewHeader.appendChild(previewBackBtn);
  const previewStage = document.createElement("div");
  previewStage.className = "preview-stage";
  previewSection.appendChild(previewHeader);
  previewSection.appendChild(previewStage);
  meta.appendChild(previewSection);

  // ── description (optional) ────────────────────────────────────────────
  const descText = model.description ? htmlToPlainText(model.description) : "";
  if (descText) {
    const desc = document.createElement("section");
    desc.className = "description";
    const h = document.createElement("h2");
    h.textContent = "Description";
    const body = document.createElement("div");
    body.className = "description-body";
    body.textContent = descText;
    desc.appendChild(h);
    desc.appendChild(body);
    meta.appendChild(desc);
  }

  // ── downloads panel (populated on demand) ─────────────────────────────
  const downloadsSection = document.createElement("section");
  downloadsSection.className = "downloads";
  downloadsSection.hidden = true;
  const dlHeader = document.createElement("h2");
  dlHeader.textContent = "Download links";
  const dlList = document.createElement("ul");
  dlList.className = "download-list";
  const dlHint = document.createElement("p");
  dlHint.className = "hint";
  downloadsSection.appendChild(dlHeader);
  downloadsSection.appendChild(dlList);
  downloadsSection.appendChild(dlHint);
  meta.appendChild(downloadsSection);

  container.appendChild(gallery);
  container.appendChild(meta);

  renderGallery();

  // ── CTA handlers ──────────────────────────────────────────────────────
  const externalUrl =
    safeHttpUrl(model.url) ??
    `https://www.cgtrader.com/3d-models/${model.id ?? 0}`;

  const onExternal = async (): Promise<void> => {
    try {
      await deps.openLink({ url: externalUrl });
    } catch (e) {
      console.error("openLink failed", e);
      window.open(externalUrl, "_blank", "noopener,noreferrer");
    }
  };
  externalBtn.addEventListener("click", onExternal);

  const renderDownloads = (result: DownloadResult): void => {
    clearChildren(dlList);
    for (const f of result.files) {
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
          void deps
            .openLink({ url: f.download_url! })
            .catch((err) => console.error("openLink failed", err));
        });
        li.appendChild(a);
      } else {
        li.className = "failed";
        li.textContent = `${label} — unavailable${f.error ? `: ${f.error}` : ""}`;
      }
      dlList.appendChild(li);
    }
    dlHint.textContent = result.expires_hint ?? "";
    downloadsSection.hidden = result.files.length === 0;
  };

  const onDownload = async (): Promise<void> => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = "Fetching links…";
    try {
      const res = await deps.callServerTool({
        name: "cgtrader_get_free_model_download_urls",
        arguments: { model_id: model.id },
      });
      const payload = res.structuredContent as DownloadResult | undefined;
      if (payload) renderDownloads(payload);
    } catch (e) {
      console.error("download fetch failed", e);
      dlHint.textContent =
        e instanceof Error ? e.message : "Failed to fetch download links.";
      downloadsSection.hidden = false;
    } finally {
      downloadBtn.disabled = !(model.files && model.files.length > 0);
      downloadBtn.textContent = "Get free download";
    }
  };
  downloadBtn.addEventListener("click", onDownload);

  // ── preview CTA handler ───────────────────────────────────────────────
  let previewDisposer: PreviewDisposer | null = null;
  const mountPreview = deps.mountPreview;

  const closePreview = (): void => {
    previewDisposer?.();
    previewDisposer = null;
    clearChildren(previewStage);
    previewStatus.textContent = "";
    previewSection.hidden = true;
    previewBtn.disabled = !canPreview;
    previewBtn.textContent = "See preview";
  };

  const onPreview = async (): Promise<void> => {
    if (!mountPreview) return;
    previewBtn.disabled = true;
    previewBtn.textContent = "Loading preview…";
    previewSection.hidden = false;
    previewStatus.textContent = "Resolving preview URL…";
    clearChildren(previewStage);
    try {
      const res = await deps.callServerTool({
        name: "cgtrader_preview_model_3d",
        arguments: { model_id: model.id },
      });
      const payload = res.structuredContent as PreviewResult | undefined;
      if (!payload || !payload.picked) {
        const ext = payload?.unsupported_extensions ?? [];
        previewStatus.textContent =
          ext.length > 0
            ? `No web preview — ships as ${ext.join(", ")}.`
            : "No web-viewable file on this model.";
        previewBtn.disabled = !canPreview;
        previewBtn.textContent = "See preview";
        return;
      }
      previewStatus.textContent = "Booting viewer…";
      previewDisposer?.();
      previewDisposer = await mountPreview({
        container: previewStage,
        data: payload,
        onStatus: (msg) => {
          previewStatus.textContent = msg;
        },
      });
      previewBtn.textContent = "Reload preview";
      previewBtn.disabled = false;
    } catch (e) {
      console.error("preview failed", e);
      previewStatus.textContent =
        e instanceof Error ? e.message : "Failed to load preview.";
      previewBtn.disabled = !canPreview;
      previewBtn.textContent = "See preview";
    }
  };
  previewBtn.addEventListener("click", onPreview);
  previewBackBtn.addEventListener("click", closePreview);

  return {
    destroy() {
      prevBtn.removeEventListener("click", onPrev);
      nextBtn.removeEventListener("click", onNext);
      externalBtn.removeEventListener("click", onExternal);
      downloadBtn.removeEventListener("click", onDownload);
      previewBtn.removeEventListener("click", onPreview);
      previewBackBtn.removeEventListener("click", closePreview);
      previewDisposer?.();
      previewDisposer = null;
    },
  };
}

// Keys are the raw values returned by the CGTrader API; titles mirror the
// labels used in the CGTrader web app's license picker. Unknown keys fall
// back to the raw value so we don't silently drop future additions.
const LICENSE_LABELS: Record<string, string> = {
  royalty_free: "Royalty Free",
  royalty_free_no_ai: "Royalty Free, no Ai",
  custom: "Custom",
  custom_no_ai: "Custom, no Ai",
  editorial: "Editorial",
  editorial_no_ai: "Editorial, no Ai",
};

function licenseLabel(raw: string): string {
  return LICENSE_LABELS[raw] ?? raw;
}

/**
 * Strips HTML tags from CGTrader's description field while preserving
 * paragraph breaks. We parse (not innerHTML-assign) so no scripts execute,
 * then read textContent from each top-level child to keep <p>/<br> structure
 * as blank lines — the CSS on .description-body is `white-space: pre-wrap`
 * which renders those newlines visually.
 */
function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const children = Array.from(doc.body.children);
  if (children.length === 0) return (doc.body.textContent ?? "").trim();
  const parts: string[] = [];
  for (const node of children) {
    const text = (node.textContent ?? "").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
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
