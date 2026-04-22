import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyHostContext } from "../../shared/host-context.ts";
import {
  renderModelDetail,
  type ModelDetailHandle,
} from "../../shared/model-detail.ts";
import type { ViewModelResult } from "../../shared/types.ts";
import "./styles.css";

const root = document.getElementById("app")!;
const summaryEl = document.getElementById("summary")!;
const containerEl = document.getElementById("detail-container") as HTMLElement;
const loaderEl = document.getElementById("loader") as HTMLElement;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;

let displayMode: "inline" | "fullscreen" | string = "inline";
let handle: ModelDetailHandle | null = null;

function setLoading(on: boolean): void {
  loaderEl.hidden = !on;
  containerEl.hidden = on;
}

function showError(message: string): void {
  setLoading(false);
  containerEl.hidden = true;
  const existing = root.querySelector(".error");
  if (existing) existing.remove();
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = message;
  root.appendChild(box);
}

const app = new App({ name: "CGTrader Model Detail", version: "0.1.0" });

app.onhostcontextchanged = (ctx) => {
  applyHostContext(root, ctx, {
    fullscreenBtn,
    onDisplayMode: (m) => {
      displayMode = m;
    },
  });
};

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
  summaryEl.textContent = `Free model · id ${structured.model.id}`;
  handle?.destroy();
  handle = renderModelDetail(containerEl, structured, {
    callServerTool: (p) => app.callServerTool(p),
    openLink: (p) => app.openLink(p),
  });
};

app.onerror = (e) => {
  setLoading(false);
  console.error(e);
};

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
