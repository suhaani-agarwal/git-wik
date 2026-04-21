/**
 * Public extraction API.
 * Replaces the old src/extract/llm.ts.
 *
 * Usage:
 *   import { extractThread } from "../extract/extract.js";
 *   const result = await extractThread(threadText);          // auto provider
 *   const result = await extractThread(threadText, "gemini"); // force Gemini
 */
import { createProvider } from "./factory.js";
import { EMPTY_RESULT } from "./types.js";
import type { ExtractionResult, ProviderName } from "./types.js";

export type { ExtractionResult, ProviderName, LLMProvider, RejectedAlt } from "./types.js";
export { EMPTY_RESULT } from "./types.js";
export { createProvider } from "./factory.js";

export async function extractThread(
  threadText: string,
  provider: ProviderName = "auto"
): Promise<ExtractionResult> {
  const p = createProvider(provider);
  if (!p) return EMPTY_RESULT;
  return p.extractThread(threadText);
}
