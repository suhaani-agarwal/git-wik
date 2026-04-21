/**
 * Keyword extraction for FTS5 indexing.
 *
 * Turns a GitHub issue/PR title + labels + body sample into a compact set of
 * searchable tokens stored in the node_keywords table and synced into FTS5.
 * No external dependencies, no API calls.
 */

// Common English + development stopwords that carry no search signal.
const STOPWORDS = new Set([
  // English function words
  "a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of",
  "and", "or", "with", "this", "that", "was", "are", "be", "by", "from",
  "not", "have", "has", "had", "but", "if", "can", "will", "when",
  "where", "which", "who", "how", "what", "all", "as", "up", "out",
  "do", "we", "my", "our", "its", "no", "so", "then", "than", "more",
  // Dev-specific noise words
  "fix", "bug", "issue", "update", "change", "add", "remove", "refactor",
  "feat", "chore", "docs", "test", "pr", "pull", "request", "code",
  "work", "get", "set", "use", "run", "make", "new", "old",
]);

const MIN_TOKEN_LEN = 3;
const MAX_TOKENS = 50;

/**
 * Extract searchable keyword tokens from an issue/PR.
 *
 * Strategy:
 * 1. Title words (highest signal — always included)
 * 2. Label names and their parts (e.g., "type:bug" → "type", "bug")
 * 3. CamelCase/snake_case symbol names from body (AuthService, jwt_decode)
 * 4. File-path-like strings (src/auth/index.ts → "auth", "index")
 * 5. PascalCase error/exception names (TypeError, AuthenticationError)
 *
 * Returns a space-separated lowercase string of up to 50 unique tokens.
 */
export function extractKeywords(
  title: string,
  labels: string[],
  bodySample: string
): string {
  const tokens = new Set<string>();

  // 1. Title words
  for (const word of title.toLowerCase().split(/\W+/)) {
    if (word.length >= MIN_TOKEN_LEN && !STOPWORDS.has(word)) {
      tokens.add(word);
    }
  }

  // 2. Label names and their parts
  for (const label of labels) {
    const normalized = label.toLowerCase();
    tokens.add(normalized.replace(/[:/\s]+/g, "_"));
    for (const part of normalized.split(/[:/\s_-]+/)) {
      if (part.length >= MIN_TOKEN_LEN && !STOPWORDS.has(part)) {
        tokens.add(part);
      }
    }
  }

  // 3. CamelCase identifiers: AuthService, useEffect, jwtDecode
  const camelRe = /\b([a-z][a-zA-Z]{3,}[A-Z]\w*|[A-Z][a-z]{2,}[A-Z]\w*)\b/g;
  for (const m of bodySample.matchAll(camelRe)) {
    tokens.add(m[1]!.toLowerCase());
  }

  // 4. snake_case identifiers: jwt_decode, rate_limit
  const snakeRe = /\b([a-z][a-z0-9]{1,}(?:_[a-z][a-z0-9]+){1,})\b/g;
  for (const m of bodySample.matchAll(snakeRe)) {
    if (!STOPWORDS.has(m[1]!)) tokens.add(m[1]!);
  }

  // 5. File paths: src/auth/index.ts — extract meaningful segments
  const pathRe = /[\w-]+\/[\w./\-]+\.[a-z]{1,5}/g;
  for (const m of bodySample.matchAll(pathRe)) {
    const parts = m[0]!.split(/[/.\-]/);
    for (const p of parts) {
      if (p.length >= MIN_TOKEN_LEN && !STOPWORDS.has(p.toLowerCase())) {
        tokens.add(p.toLowerCase());
      }
    }
  }

  // 6. PascalCase names ≥6 chars (error names, class names)
  const pascalRe = /\b([A-Z][a-z]{2,}(?:[A-Z][a-z]*){1,})\b/g;
  for (const m of bodySample.matchAll(pascalRe)) {
    tokens.add(m[1]!.toLowerCase());
  }

  return [...tokens].slice(0, MAX_TOKENS).join(" ");
}

/**
 * Build a FTS5 MATCH query string from a natural-language query.
 * Strips stopwords, lowercases, and joins remaining tokens with OR.
 *
 * Example: "add rate limiting to auth middleware"
 *   → '"rate limiting" OR rate OR limiting OR auth OR middleware'
 */
export function buildFtsQuery(query: string): string {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN && !STOPWORDS.has(w));

  if (words.length === 0) return query.trim();

  const terms: string[] = [];

  // Add bigrams as phrase matches (higher precision)
  for (let i = 0; i < words.length - 1; i++) {
    terms.push(`"${words[i]} ${words[i + 1]}"`);
  }

  // Add individual tokens (higher recall)
  for (const w of words) {
    terms.push(w);
  }

  return [...new Set(terms)].join(" OR ");
}
