/**
 * Token budget utilities for MCP response formatting.
 *
 * Rough heuristic: 1 token ≈ 4 chars for English prose/Markdown.
 * We use this to truncate responses before they exceed Claude's
 * useful context budget for a single tool call.
 */

const CHARS_PER_TOKEN = 3;

/**
 * Truncate Markdown content to stay within a token budget.
 * Truncates at the last complete `##` section boundary to avoid
 * cutting mid-sentence or mid-list.
 *
 * @param content     Markdown string to truncate
 * @param tokenBudget Max tokens (default: 700)
 * @returns           Possibly-truncated Markdown
 */
export function formatWithBudget(
  content: string,
  tokenBudget = 700
): string {
  const charLimit = tokenBudget * CHARS_PER_TOKEN;
  if (content.length <= charLimit) return content;

  // Find the last ## heading before the char limit
  const truncated = content.slice(0, charLimit);
  const lastSection = truncated.lastIndexOf("\n##");

  // Only truncate at a section boundary if it leaves at least half the budget
  if (lastSection > charLimit * 0.4) {
    return (
      truncated.slice(0, lastSection) +
      "\n\n*[truncated — use `depth: \"full\"` for complete output]*"
    );
  }

  // Fallback: truncate at last newline
  const lastNewline = truncated.lastIndexOf("\n");
  return (
    truncated.slice(0, lastNewline > 0 ? lastNewline : charLimit) +
    "\n\n*[truncated]*"
  );
}

/**
 * Estimate token count for a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate a string to a max character length, ending at a word boundary.
 */
export function truncateAt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.7 ? cut.slice(0, lastSpace) : cut) + "…";
}
