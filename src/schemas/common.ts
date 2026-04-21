import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";
import { ResponseFormat } from "../types.js";

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for human-readable, 'json' for structured data.",
  );

export const pageField = z
  .number()
  .int()
  .min(1)
  .default(1)
  .describe("Page number (1-indexed).");

export const perPageField = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .describe(`Results per page (1-${MAX_PAGE_SIZE}).`);

export const modelIdField = z
  .number()
  .int()
  .positive()
  .describe("Numeric CGTrader model id.");

export const categoryIdField = z
  .number()
  .int()
  .positive()
  .describe("Numeric CGTrader category id.");
