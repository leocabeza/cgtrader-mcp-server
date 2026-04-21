import { describe, expect, it } from "vitest";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat, type CGTraderModel } from "../types.js";
import {
  modelSummaryLine,
  modelsToMarkdown,
  renderText,
  truncateIfNeeded,
} from "./format.js";

describe("modelSummaryLine", () => {
  it("renders title, author and the first five tags", () => {
    const model: CGTraderModel = {
      id: 42,
      title: "Brown Chair",
      author_name: "alice",
      tags: ["one", "two", "three", "four", "five", "six"],
    };
    expect(modelSummaryLine(model)).toBe(
      "- **Brown Chair** (id: 42) by alice — tags: one, two, three, four, five",
    );
  });

  it("falls back to `Model {id}` when title is missing", () => {
    expect(modelSummaryLine({ id: 7 })).toBe("- **Model 7** (id: 7)");
  });
});

describe("modelsToMarkdown", () => {
  it("emits a placeholder line when there are no models", () => {
    const md = modelsToMarkdown("Free models", [], {
      page: 1,
      per_page: 25,
      total: 0,
      has_more: false,
    });
    expect(md).toContain("# Free models");
    expect(md).toContain("_No matching free models found._");
  });
});

describe("truncateIfNeeded", () => {
  it("passes short text through untouched", () => {
    const { text, truncated } = truncateIfNeeded("hello");
    expect(truncated).toBe(false);
    expect(text).toBe("hello");
  });

  it("truncates and appends the overflow suffix", () => {
    const input = "a".repeat(CHARACTER_LIMIT + 1000);
    const { text, truncated } = truncateIfNeeded(input);
    expect(truncated).toBe(true);
    expect(text.length).toBe(CHARACTER_LIMIT);
    expect(text).toContain("response truncated at");
  });
});

describe("renderText", () => {
  it("returns the markdown string when format=markdown", () => {
    const out = renderText(ResponseFormat.MARKDOWN, "# hi", { anything: 1 });
    expect(out).toBe("# hi");
  });

  it("returns pretty-printed JSON when format=json", () => {
    const out = renderText(ResponseFormat.JSON, "unused", { a: 1 });
    expect(out).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});
