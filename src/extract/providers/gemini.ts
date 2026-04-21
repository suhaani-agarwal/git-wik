import type { LLMProvider, ExtractionResult } from "../types.js";
import { EMPTY_RESULT } from "../types.js";
import { EXTRACTION_SYSTEM_PROMPT, buildUserMessage } from "../prompts.js";

function parseResponse(raw: string): ExtractionResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  return {
    problem_statement: (parsed["problem_statement"] as string | null) ?? null,
    choice_made:       (parsed["choice_made"] as string | null) ?? null,
    rationale:         (parsed["rationale"] as string | null) ?? null,
    outcome:           (parsed["outcome"] as ExtractionResult["outcome"]) ?? "open",
    outcome_reason:    (parsed["outcome_reason"] as string | null) ?? null,
    rejected_alternatives: (parsed["rejected_alternatives"] as ExtractionResult["rejected_alternatives"]) ?? [],
    constraints:       (parsed["constraints"] as string[]) ?? [],
    fixes_issues:      (parsed["fixes_issues"] as number[]) ?? [],
    confidence:        (parsed["confidence"] as number) ?? 0,
  };
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;

  constructor(private readonly apiKey: string) {}

  async extractThread(threadText: string): Promise<ExtractionResult> {
    // Use @google/genai (v1.x, active) — NOT the deprecated @google/generative-ai.
    // Gemini does not support prompt caching in the Node.js SDK yet,
    // so system prompt and user content are concatenated in one call.
    let GoogleGenAI: typeof import("@google/genai").GoogleGenAI;
    try {
      ({ GoogleGenAI } = await import("@google/genai"));
    } catch {
      return EMPTY_RESULT;
    }

    const ai = new GoogleGenAI({ apiKey: this.apiKey });

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: EXTRACTION_SYSTEM_PROMPT + "\n\n" + buildUserMessage(threadText),
      });

      const text = response.text;
      if (!text) return EMPTY_RESULT;

      return parseResponse(text);
    } catch {
      return EMPTY_RESULT;
    }
  }
}
