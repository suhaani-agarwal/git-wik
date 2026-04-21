import type { LLMProvider, ExtractionResult } from "../types.js";
import { EMPTY_RESULT } from "../types.js";
import { EXTRACTION_SYSTEM_PROMPT, buildUserMessage } from "../prompts.js";

function parseResponse(raw: string): ExtractionResult {
  // Strip optional markdown code fences the model may add
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

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;

  constructor(private readonly apiKey: string) {}

  async extractThread(threadText: string): Promise<ExtractionResult> {
    // Dynamic import keeps @anthropic-ai/sdk out of the MCP server bundle
    // when installed via npx (it's a devDependency, not in production deps).
    let Anthropic: typeof import("@anthropic-ai/sdk").default;
    try {
      ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
    } catch {
      return EMPTY_RESULT;
    }

    const client = new Anthropic({ apiKey: this.apiKey });

    try {
      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        // System must be an ARRAY for cache_control to work (not a plain string).
        // The static system prompt is cached; only the variable thread costs full tokens.
        system: [
          {
            type: "text",
            text: EXTRACTION_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: buildUserMessage(threadText),
          },
        ],
      });

      const textBlock = message.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") return EMPTY_RESULT;

      return parseResponse(textBlock.text);
    } catch {
      return EMPTY_RESULT;
    }
  }
}
