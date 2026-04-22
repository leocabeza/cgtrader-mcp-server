import { App } from "@modelcontextprotocol/ext-apps";
import type {
  CallToolRequest,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { SupportedFormat } from "@cgtrader/cgt-viewer";
import { applyHostContext } from "../../shared/host-context.ts";
import {
  mountPreview,
  type PreviewHandle,
} from "../../shared/preview.ts";
import type {
  DownloadResult,
  PreviewCandidate,
  PreviewResult,
} from "../../shared/types.ts";
import "./styles.css";

const root = document.getElementById("app")!;
const summaryEl = document.getElementById("summary")!;
const stageEl = document.getElementById("viewer-stage") as HTMLElement;
const loaderEl = document.getElementById("loader") as HTMLElement;
const loaderLabelEl = loaderEl.querySelector(".loader-label") as HTMLElement;
const candidateSelect = document.getElementById(
  "candidate-select",
) as HTMLSelectElement;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;

let displayMode: "inline" | "fullscreen" | string = "inline";
let handle: PreviewHandle | null = null;
let currentResult: PreviewResult | null = null;
let loadToken = 0;

function setLoading(on: boolean, label?: string): void {
  loaderEl.hidden = !on;
  loaderLabelEl.textContent = label ?? "Loading preview…";
}

function clearStage(): void {
  handle?.dispose();
  handle = null;
  // Loader lives inside the stage as an overlay — preserve it so the
  // spinner stays visible during format switches.
  Array.from(stageEl.children).forEach((child) => {
    if (child !== loaderEl) stageEl.removeChild(child);
  });
}

function showError(message: string): void {
  setLoading(false);
  clearStage();
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = message;
  stageEl.appendChild(box);
}

function showEmpty(message: string): void {
  setLoading(false);
  clearStage();
  const box = document.createElement("div");
  box.className = "empty";
  box.textContent = message;
  stageEl.appendChild(box);
}

function renderCandidateOptions(result: PreviewResult): void {
  while (candidateSelect.firstChild) {
    candidateSelect.removeChild(candidateSelect.firstChild);
  }
  if (result.candidates.length <= 1) {
    candidateSelect.hidden = true;
    return;
  }
  for (const c of result.candidates) {
    const opt = document.createElement("option");
    opt.value = String(c.file_id);
    opt.textContent = `${c.name ?? `file ${c.file_id}`} (${c.extension})`;
    if (result.picked && c.file_id === result.picked.file_id) {
      opt.selected = true;
    }
    candidateSelect.appendChild(opt);
  }
  candidateSelect.hidden = false;
}

async function loadCandidate(
  candidate: PreviewCandidate,
  downloadUrl: string,
): Promise<void> {
  const myToken = ++loadToken;
  clearStage();
  setLoading(true, "Booting viewer…");
  summaryEl.textContent = `Previewing ${candidate.name ?? `file ${candidate.file_id}`}`;
  try {
    const mounted = await mountPreview({
      container: stageEl,
      url: downloadUrl,
      format: candidate.extension as SupportedFormat,
      name: candidate.name,
      onStatus: (msg) => {
        if (myToken === loadToken && msg) setLoading(true, msg);
      },
    });
    if (myToken !== loadToken) {
      mounted.dispose();
      return;
    }
    handle = mounted;
    setLoading(false);
  } catch (err) {
    if (myToken !== loadToken) return;
    const msg = err instanceof Error ? err.message : String(err);
    showError(`Failed to load model: ${msg}`);
  }
}

async function resolveSignedUrlFor(
  modelId: number,
  fileId: number,
): Promise<string> {
  const res = await app.callServerTool({
    name: "cgtrader_download_free_file",
    arguments: { model_id: modelId, file_id: fileId },
  });
  const payload = res.structuredContent as
    | { download_url?: string }
    | undefined;
  if (!payload?.download_url) {
    throw new Error(
      res.isError && res.content?.[0]?.type === "text"
        ? (res.content[0] as { text: string }).text
        : `Could not resolve a download URL for file ${fileId}.`,
    );
  }
  return payload.download_url;
}

async function switchToCandidate(fileId: number): Promise<void> {
  if (!currentResult) return;
  const candidate = currentResult.candidates.find(
    (c) => c.file_id === fileId,
  );
  if (!candidate) return;
  try {
    const url = await resolveSignedUrlFor(currentResult.model_id, fileId);
    await loadCandidate(candidate, url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
  }
}

function handleResult(result: PreviewResult): void {
  currentResult = result;
  renderCandidateOptions(result);

  if (!result.picked) {
    const ext = result.unsupported_extensions;
    const title = result.model_title ?? `model ${result.model_id}`;
    summaryEl.textContent = `No web preview available for ${title}`;
    showEmpty(
      ext.length > 0
        ? `This model ships only as ${ext.join(", ")} — download it and open in a native DCC tool.`
        : "This model has no files attached.",
    );
    return;
  }

  const title = result.model_title ?? `model ${result.model_id}`;
  summaryEl.textContent = `${title} · ${result.picked.extension}`;
  void loadCandidate(result.picked, result.picked.download_url);
}

// Rarely used from this bundle (the tool typically returns a fully-resolved
// preview), but keep it symmetric with DownloadResult in case a caller feeds
// us the older shape.
function isDownloadResult(x: unknown): x is DownloadResult {
  return !!x && typeof x === "object" && "files" in (x as Record<string, unknown>);
}

const app = new App({ name: "CGTrader Model Preview", version: "0.1.0" });

app.onhostcontextchanged = (ctx) => {
  applyHostContext(root, ctx, {
    fullscreenBtn,
    onDisplayMode: (m) => {
      displayMode = m;
    },
  });
};

app.ontoolinput = (params: CallToolRequest["params"]) => {
  setLoading(true, "Resolving preview…");
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const hint = typeof args.url === "string" ? args.url : args.model_id;
  summaryEl.textContent = hint ? `Preparing preview for ${hint}` : "Preparing preview…";
  clearStage();
};

app.ontoolresult = (result: CallToolResult) => {
  const structured = result.structuredContent as
    | (PreviewResult & { error?: string })
    | undefined;
  if (result.isError || !structured || isDownloadResult(structured)) {
    const msg =
      result.content?.[0]?.type === "text"
        ? (result.content[0] as { text: string }).text
        : "Preview tool returned no usable data.";
    showError(msg);
    return;
  }
  handleResult(structured);
};

app.onerror = (e) => {
  setLoading(false);
  console.error(e);
};

candidateSelect.addEventListener("change", () => {
  const fileId = Number(candidateSelect.value);
  if (Number.isFinite(fileId)) void switchToCandidate(fileId);
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
  if (ctx) {
    applyHostContext(root, ctx, {
      fullscreenBtn,
      onDisplayMode: (m) => {
        displayMode = m;
      },
    });
  }
});
