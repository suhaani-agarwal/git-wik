/**
 * EXTRACTION_SYSTEM_PROMPT is the static portion of the extraction prompt.
 * It is sent as a cached system message for Anthropic (cache_control: ephemeral)
 * so repeated calls during batch enrichment only pay ~10% of input token cost.
 *
 * For Gemini, it is prepended directly to the user content (no caching support yet).
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are a technical analyst extracting structured data from GitHub discussion threads.

Rules:
- Extract ONLY what is EXPLICITLY stated in the thread. Never infer or assume.
- Use null when information is not clearly stated.
- Return only valid JSON matching the schema exactly. No markdown fences, no explanation.
- Confidence scoring:
    0.9+  explicit decision with clearly stated rationale
    0.7   clear decision, rationale implied but not stated
    0.4   more discussion than decision
    0.1   no clear decision made

Output schema (return this object and nothing else):
{
  "problem_statement": "1 sentence: what problem was being solved. null if not a decision thread.",
  "choice_made": "1 sentence: what was decided or implemented. null if just discussion.",
  "rationale": "1 sentence: WHY this choice — must be explicitly stated. null if not stated.",
  "outcome": "merged|rejected|abandoned|open",
  "outcome_reason": "1 sentence: why merged OR why rejected. null if not stated.",
  "rejected_alternatives": [
    {
      "option": "what was proposed as an alternative",
      "reason": "why it was rejected — must be explicitly stated in thread",
      "by": "username of person who rejected it, or null"
    }
  ],
  "constraints": [
    "a technical or product constraint explicitly stated, e.g. must work without Redis"
  ],
  "fixes_issues": [1234],
  "confidence": 0.0
}`;

/**
 * Wrap variable thread text for the user message.
 * Keep the system prompt separate so Anthropic can cache it.
 */
export function buildUserMessage(threadText: string): string {
  return `<thread>\n${threadText}\n</thread>`;
}
