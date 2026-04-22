import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

export type HostContextHooks = {
  /** Button to show/label based on available display modes. */
  fullscreenBtn?: HTMLButtonElement | null;
  /** Called whenever `displayMode` changes so callers can track it. */
  onDisplayMode?: (mode: string) => void;
};

/**
 * Applies host context to the document: theme/fonts/variables, safe-area
 * insets on the given root, and optional fullscreen button labeling.
 * Shared across UI bundles so every new UI gets the same treatment.
 */
export function applyHostContext(
  root: HTMLElement,
  ctx: McpUiHostContext,
  hooks: HostContextHooks = {},
): void {
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

  const btn = hooks.fullscreenBtn;
  if (btn && ctx.availableDisplayModes?.includes("fullscreen")) {
    btn.hidden = false;
  }

  if (ctx.displayMode) {
    hooks.onDisplayMode?.(ctx.displayMode);
    if (btn) {
      btn.textContent =
        ctx.displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
    }
  }
}
