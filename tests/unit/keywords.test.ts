import { describe, it, expect } from "vitest";
import { extractKeywords, buildFtsQuery } from "../../src/shared/keywords.js";

describe("extractKeywords", () => {
  it("extracts words from title, filtering stopwords", () => {
    const kw = extractKeywords("Add rate limiting to auth middleware", [], "");
    const tokens = kw.split(" ");
    expect(tokens).toContain("rate");
    expect(tokens).toContain("limiting");
    expect(tokens).toContain("auth");
    expect(tokens).toContain("middleware");
    // stopwords should be removed
    expect(tokens).not.toContain("add");
    expect(tokens).not.toContain("to");
  });

  it("filters short tokens (< 3 chars)", () => {
    // Use a title with a mix of short and long words; only ≥3-char non-stopwords should appear
    const kw = extractKeywords("An authentication middleware slowdown", [], "");
    const tokens = kw.split(" ").filter((t) => t.length > 0);
    expect(tokens.every((t) => t.length >= 3)).toBe(true);
    expect(tokens).not.toContain("an");
  });

  it("includes label names and their parts", () => {
    const kw = extractKeywords("crash", ["type:bug", "area:auth"], "");
    const tokens = kw.split(" ");
    expect(tokens).toContain("auth");
    // label parts extracted
    expect(tokens.some((t) => t === "type_bug" || t === "type")).toBe(true);
  });

  it("extracts camelCase symbols from body", () => {
    const kw = extractKeywords("crash", [], "The useAuthToken hook in AuthService.ts is broken");
    const tokens = kw.split(" ");
    expect(tokens).toContain("useauthtoken");
  });

  it("extracts snake_case identifiers from body", () => {
    const kw = extractKeywords("crash", [], "jwt_decode fails when auth_token is missing");
    const tokens = kw.split(" ");
    expect(tokens).toContain("jwt_decode");
    expect(tokens).toContain("auth_token");
  });

  it("extracts file path segments from body", () => {
    const kw = extractKeywords("crash", [], "See src/auth/index.ts for details");
    const tokens = kw.split(" ");
    expect(tokens).toContain("auth");
    expect(tokens).toContain("index");
  });

  it("extracts PascalCase names from body", () => {
    const kw = extractKeywords("crash", [], "Throws AuthenticationError on invalid token");
    const tokens = kw.split(" ");
    expect(tokens).toContain("authenticationerror");
  });

  it("returns at most 50 tokens", () => {
    const longBody = Array.from({ length: 100 }, (_, i) => `TokenName${i}`).join(" ");
    const kw = extractKeywords("title", [], longBody);
    const tokens = kw.split(" ").filter((t) => t.length > 0);
    expect(tokens.length).toBeLessThanOrEqual(50);
  });

  it("handles empty inputs gracefully", () => {
    const kw = extractKeywords("", [], "");
    expect(typeof kw).toBe("string");
  });

  it("deduplicates tokens", () => {
    const kw = extractKeywords("auth token auth token", [], "");
    const tokens = kw.split(" ");
    const unique = new Set(tokens);
    expect(unique.size).toBe(tokens.length);
  });
});

describe("buildFtsQuery", () => {
  it("strips stopwords and builds OR-joined query", () => {
    const q = buildFtsQuery("add rate limiting to auth middleware");
    expect(q).toContain("rate");
    expect(q).toContain("limiting");
    expect(q).toContain("auth");
    expect(q).toContain("middleware");
    expect(q).not.toContain('"add');
    expect(q).not.toContain("OR to ");
  });

  it("adds bigram phrase matches for multi-word queries", () => {
    const q = buildFtsQuery("rate limiting middleware");
    expect(q).toContain('"rate limiting"');
    expect(q).toContain('"limiting middleware"');
  });

  it("handles single meaningful word", () => {
    const q = buildFtsQuery("authentication");
    expect(q).toBe("authentication");
  });

  it("returns the raw query if all words are stopwords", () => {
    const q = buildFtsQuery("fix bug");
    // "fix" and "bug" are both stopwords — returns original
    expect(q).toBe("fix bug");
  });

  it("deduplicates terms in the output", () => {
    const q = buildFtsQuery("auth auth middleware");
    const parts = q.split(" OR ");
    const unique = new Set(parts);
    expect(unique.size).toBe(parts.length);
  });

  it("lowercases all search tokens (OR connector stays uppercase for FTS5)", () => {
    const q = buildFtsQuery("AuthService RateLimiter");
    // Tokens are lowercased; "OR" connector is uppercase (required by FTS5 syntax)
    const parts = q.split(" OR ");
    for (const part of parts) {
      // Each part (after stripping quotes) should be lowercase
      expect(part.replace(/"/g, "")).toBe(part.replace(/"/g, "").toLowerCase());
    }
  });
});
