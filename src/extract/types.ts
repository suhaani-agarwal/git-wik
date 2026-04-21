export interface RejectedAlt {
  option: string;
  reason: string | null;
  by: string | null;
}

export interface ExtractionResult {
  problem_statement: string | null;
  choice_made: string | null;
  rationale: string | null;
  outcome: "merged" | "rejected" | "abandoned" | "open";
  outcome_reason: string | null;
  rejected_alternatives: RejectedAlt[];
  constraints: string[];
  fixes_issues: number[];
  confidence: number;
}

export const EMPTY_RESULT: ExtractionResult = {
  problem_statement: null,
  choice_made: null,
  rationale: null,
  outcome: "open",
  outcome_reason: null,
  rejected_alternatives: [],
  constraints: [],
  fixes_issues: [],
  confidence: 0,
};

export type ProviderName = "anthropic" | "gemini" | "auto";

export interface LLMProvider {
  readonly name: "anthropic" | "gemini";
  extractThread(threadText: string): Promise<ExtractionResult>;
}
