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

  // ── description (optional) ────────────────────────────────────────────
  const descFrag = model.description
    ? buildDescriptionFragment(model.description)
    : null;
  const descSection = document.createElement("section");
  descSection.className = "description";
  let descBody: HTMLDivElement | null = null;
  if (descFrag) {
    const h = document.createElement("h2");
    h.textContent = "Description";
    descBody = document.createElement("div");
    descBody.className = "description-body";
    descBody.appendChild(descFrag);
    descSection.appendChild(h);
    descSection.appendChild(descBody);
  } else {
    descSection.hidden = true;
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

  // Full-width rows below the gallery/meta grid row. The preview panel, the
  // description, and the downloads panel each span `grid-column: 1 / -1` so
  // prose can breathe and short descriptions don't leave a void next to the
  // gallery.
  container.appendChild(gallery);
  container.appendChild(meta);
  container.appendChild(previewSection);
  container.appendChild(descSection);
  container.appendChild(downloadsSection);

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

  // Route anchors embedded in the description through deps.openLink so hosts
  // (Claude Desktop, etc.) that intercept external navigation stay in charge.
  const onDescriptionClick = (e: Event): void => {
    const anchor = (e.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    void deps
      .openLink({ url: href })
      .catch((err) => console.error("openLink failed", err));
  };
  if (descBody) descBody.addEventListener("click", onDescriptionClick);

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
      descBody?.removeEventListener("click", onDescriptionClick);
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

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "P",
  "DIV",
  "LI",
  "UL",
  "OL",
  "BLOCKQUOTE",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

const URL_REGEX = /\bhttps?:\/\/\S+/g;
const URL_TRAIL_PUNCT = /[.,!?;:)\]}>]+$/;

function linkifyInto(text: string, out: DocumentFragment | Element): void {
  if (!text) return;
  let lastIdx = 0;
  for (const m of text.matchAll(URL_REGEX)) {
    const start = m.index ?? 0;
    if (start > lastIdx) {
      out.appendChild(document.createTextNode(text.slice(lastIdx, start)));
    }
    let url = m[0];
    let trail = "";
    const pm = url.match(URL_TRAIL_PUNCT);
    if (pm) {
      trail = pm[0];
      url = url.slice(0, url.length - trail.length);
    }
    const safe = safeHttpUrl(url);
    if (safe) {
      const a = document.createElement("a");
      a.href = safe;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = url;
      out.appendChild(a);
    } else {
      out.appendChild(document.createTextNode(url));
    }
    if (trail) out.appendChild(document.createTextNode(trail));
    lastIdx = start + m[0].length;
  }
  if (lastIdx < text.length) {
    out.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

/**
 * Parses CGTrader's description HTML into a DocumentFragment, keeping anchors
 * (with safe hrefs) and linkifying bare URLs in text nodes. Block elements
 * emit trailing "\n\n" so `white-space: pre-wrap` on .description-body still
 * renders paragraph breaks. Parsing via DOMParser means no script execution
 * and no innerHTML assignment on the live document. Returns null when the
 * description has no renderable content.
 */
function buildDescriptionFragment(html: string): DocumentFragment | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const frag = document.createDocumentFragment();

  const walk = (node: Node, out: DocumentFragment): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      linkifyInto(node.textContent ?? "", out);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") return;
    if (tag === "BR") {
      out.appendChild(document.createTextNode("\n"));
      return;
    }
    if (tag === "A") {
      const rawHref = (el as HTMLAnchorElement).getAttribute("href") ?? "";
      const safe = safeHttpUrl(rawHref);
      const text = el.textContent ?? "";
      if (safe) {
        const a = document.createElement("a");
        a.href = safe;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = text || safe;
        out.appendChild(a);
      } else if (text) {
        linkifyInto(text, out);
      }
      return;
    }
    for (const child of Array.from(el.childNodes)) walk(child, out);
    if (BLOCK_TAGS.has(tag)) {
      out.appendChild(document.createTextNode("\n\n"));
    }
  };

  for (const child of Array.from(doc.body.childNodes)) walk(child, frag);

  while (frag.lastChild && frag.lastChild.nodeType === Node.TEXT_NODE) {
    const trimmed = (frag.lastChild.textContent ?? "").replace(/\s+$/, "");
    if (trimmed === "") {
      frag.removeChild(frag.lastChild);
    } else {
      frag.lastChild.textContent = trimmed;
      break;
    }
  }

  return frag.firstChild ? frag : null;
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
