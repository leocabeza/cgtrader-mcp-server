export function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function safeHttpUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function makeChip(label: string, variant?: "free"): HTMLElement {
  const span = document.createElement("span");
  span.className = variant ? `chip ${variant}` : "chip";
  span.textContent = label;
  return span;
}
