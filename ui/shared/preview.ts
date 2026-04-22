import { Viewer, checkWebGPUAvailability } from "@cgtrader/cgt-viewer";
import type { SupportedFormat } from "@cgtrader/cgt-viewer";

// Draco decoder served from jsdelivr at the three.js version pinned as a peer
// of @cgtrader/cgt-viewer. The path has to end in a trailing slash — the
// viewer appends `draco_decoder.js` / `.wasm` to it.
const DRACO_PATH =
  "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/gltf/";

export type MountPreviewParams = {
  container: HTMLElement;
  url: string;
  format: SupportedFormat;
  /** Display label — typically the filename. Falls back to URL basename. */
  name?: string;
  onStatus?: (msg: string) => void;
};

export type PreviewHandle = {
  dispose: () => void;
};

/**
 * Renders a 3D model inside `container` using @cgtrader/cgt-viewer. Creates a
 * fresh <canvas>, boots the viewer (preferring WebGPU, falling back to WebGL),
 * and loads the model from `url`. Returns a handle whose `dispose()` tears
 * down the viewer and removes the canvas — call it before unmounting or
 * reloading.
 *
 * Errors during boot or model load surface via `onStatus` and reject the
 * returned promise. On dispose mid-load, the in-flight load is discarded and
 * the viewer is still disposed cleanly (no hanging promises on `container`).
 */
export async function mountPreview(
  params: MountPreviewParams,
): Promise<PreviewHandle> {
  const { container, url, format, name, onStatus } = params;

  const canvas = document.createElement("canvas");
  canvas.className = "viewer-canvas";
  container.appendChild(canvas);

  onStatus?.("Initialising viewer…");
  const gpu = await checkWebGPUAvailability();
  const backend: "webgpu" | "webgl" = gpu.available ? "webgpu" : "webgl";

  let disposed = false;
  let viewer: Viewer | null = null;

  try {
    viewer = await Viewer.create(canvas, {
      dracoPath: DRACO_PATH,
      backend,
    });
  } catch (err) {
    // If the WebGPU backend fails to boot (older browsers / blocked adapter),
    // fall back to WebGL once. Any second failure surfaces to the caller.
    if (backend === "webgpu") {
      onStatus?.("WebGPU unavailable; retrying with WebGL…");
      viewer = await Viewer.create(canvas, {
        dracoPath: DRACO_PATH,
        backend: "webgl",
      });
    } else {
      throw err;
    }
  }

  if (disposed) {
    viewer.dispose();
    canvas.remove();
    throw new Error("disposed");
  }

  onStatus?.("Loading model…");
  const displayName = name ?? basenameFromUrl(url) ?? "model";
  try {
    await viewer.loadModel(url, displayName, format);
  } catch (err) {
    if (!disposed && viewer) viewer.dispose();
    canvas.remove();
    throw err;
  }

  if (disposed) {
    viewer.dispose();
    canvas.remove();
    throw new Error("disposed");
  }

  onStatus?.("");

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        viewer?.dispose();
      } catch {
        // Already disposed or in mid-teardown; swallow.
      }
      canvas.remove();
    },
  };
}

function basenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ?? null;
  } catch {
    return null;
  }
}
