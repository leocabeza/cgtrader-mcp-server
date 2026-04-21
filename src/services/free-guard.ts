import { CGTraderModel } from "../types.js";
import { apiGet } from "./client.js";

export function isFreeModel(model: Pick<CGTraderModel, "prices">): boolean {
  const price = model.prices?.download;
  return typeof price === "number" && price === 0;
}

/**
 * Fetches a model by id and throws a FreeOnlyViolation if it is not free.
 * Returned model is guaranteed to have prices.download === 0.
 */
export async function fetchFreeModelOrThrow(modelId: number): Promise<CGTraderModel> {
  const res = await apiGet<{ model?: CGTraderModel } | CGTraderModel>(
    `/models/${modelId}`,
  );
  const model: CGTraderModel =
    (res as { model?: CGTraderModel }).model ?? (res as CGTraderModel);

  if (!model || typeof model.id !== "number") {
    throw new FreeOnlyViolation(
      `Model ${modelId} response did not contain a model object.`,
    );
  }
  if (!isFreeModel(model)) {
    const price = model.prices?.download;
    throw new FreeOnlyViolation(
      `Model ${modelId} is not free (download price: ${price ?? "unknown"}). This server only exposes free models.`,
    );
  }
  return model;
}

export class FreeOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreeOnlyViolation";
  }
}
