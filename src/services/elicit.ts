import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";

type FormProperty =
  | {
      type: "string";
      title?: string;
      description?: string;
      oneOf: Array<{ const: string; title: string }>;
      default?: string;
    }
  | {
      type: "string";
      title?: string;
      description?: string;
      enum: string[];
      enumNames?: string[];
      default?: string;
    }
  | {
      type: "string";
      title?: string;
      description?: string;
      minLength?: number;
      maxLength?: number;
      format?: "email" | "uri" | "date" | "date-time";
      default?: string;
    }
  | {
      type: "boolean";
      title?: string;
      description?: string;
      default?: boolean;
    }
  | {
      type: "array";
      title?: string;
      description?: string;
      minItems?: number;
      maxItems?: number;
      items: {
        anyOf: Array<{ const: string; title: string }>;
      };
      default?: string[];
    };

export type FormSchema = {
  type: "object";
  properties: Record<string, FormProperty>;
  required?: string[];
};

export type FormValues = Record<string, string | number | boolean | string[]>;

/**
 * Three-way outcome:
 * - `accepted` — user submitted the form; `values` holds their choices.
 * - `declined` — user explicitly refused to answer. Callers should signal
 *   this back to the agent (e.g., "re-prompt in natural language") instead
 *   of silently applying defaults.
 * - `skipped` — host doesn't support elicitation, user cancelled the dialog
 *   without deciding, or the request errored. Callers should proceed silently
 *   with defaults.
 */
export type ElicitOutcome<T extends FormValues> =
  | { status: "accepted"; values: T }
  | { status: "declined" }
  | { status: "skipped" };

export function hostSupportsElicitation(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation !== undefined;
}

export async function elicitForm<T extends FormValues>(
  server: McpServer,
  message: string,
  requestedSchema: FormSchema,
): Promise<ElicitOutcome<T>> {
  if (!hostSupportsElicitation(server)) {
    return { status: "skipped" };
  }
  let res: ElicitResult;
  try {
    res = await server.server.elicitInput({
      mode: "form",
      message,
      requestedSchema,
    });
  } catch {
    return { status: "skipped" };
  }
  if (res.action === "accept" && res.content) {
    return { status: "accepted", values: res.content as T };
  }
  if (res.action === "decline") {
    return { status: "declined" };
  }
  return { status: "skipped" };
}
