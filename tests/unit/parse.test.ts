import { describe, it, expect } from "vitest";
import {
  parseIssueRelationships,
  extractReferencedPRNumbers,
  parsePRFiles,
  parsePRReviewers,
  parsePRReviewerStates,
  parsePROutcome,
  buildThreadText,
  buildPRThreadText,
  extractCoChangePairs,
} from "../../src/fetcher/parse.js";
import type { GhIssueRaw, GhPRRaw, GhTimelineEvent } from "../../src/fetcher/gh.js";

// ── parseIssueRelationships ───────────────────────────────────────────────────

describe("parseIssueRelationships", () => {
  it("extracts 'closes #N'", () => {
    expect(parseIssueRelationships("closes #123")).toEqual({ fixes: [123], references: [] });
  });
  it("extracts 'fixes #N'", () => {
    expect(parseIssueRelationships("fixes #42").fixes).toContain(42);
  });
  it("extracts 'resolves #N'", () => {
    expect(parseIssueRelationships("resolved #7").fixes).toContain(7);
  });
  it("extracts references", () => {
    expect(parseIssueRelationships("related to #10").references).toContain(10);
  });
  it("deduplicates", () => {
    expect(parseIssueRelationships("fixes #1 fixes #1").fixes).toHaveLength(1);
  });
  it("handles multiple on one line", () => {
    const { fixes, references } = parseIssueRelationships("fixes #1, see #2");
    expect(fixes).toContain(1);
    expect(references).toContain(2);
  });
  it("returns empty arrays for plain text", () => {
    expect(parseIssueRelationships("Updated README")).toEqual({ fixes: [], references: [] });
  });
});

// ── extractReferencedPRNumbers ────────────────────────────────────────────────

describe("extractReferencedPRNumbers", () => {
  it("extracts PR numbers from cross-reference events", () => {
    const timeline: GhTimelineEvent[] = [
      {
        event: "cross-referenced",
        source: {
          type: "issue",
          issue: { number: 55, pull_request: {} },
        },
      },
    ];
    expect(extractReferencedPRNumbers(timeline)).toContain(55);
  });
  it("ignores non-PR cross-references", () => {
    const timeline: GhTimelineEvent[] = [
      {
        event: "cross-referenced",
        source: { type: "issue", issue: { number: 10 } }, // no pull_request field
      },
    ];
    expect(extractReferencedPRNumbers(timeline)).toHaveLength(0);
  });
  it("deduplicates", () => {
    const ev: GhTimelineEvent = {
      event: "cross-referenced",
      source: { type: "issue", issue: { number: 99, pull_request: {} } },
    };
    expect(extractReferencedPRNumbers([ev, ev])).toHaveLength(1);
  });
});

// ── parsePRFiles ──────────────────────────────────────────────────────────────

describe("parsePRFiles", () => {
  it("extracts file paths", () => {
    const pr = { files: [{ path: "src/a.ts", additions: 1, deletions: 0 }] } as GhPRRaw;
    expect(parsePRFiles(pr)).toEqual(["src/a.ts"]);
  });
  it("returns empty array when files missing", () => {
    expect(parsePRFiles({} as GhPRRaw)).toEqual([]);
  });
});

// ── parsePRReviewers ──────────────────────────────────────────────────────────

describe("parsePRReviewers", () => {
  it("excludes the PR author", () => {
    const pr = {
      author: { login: "alice" },
      reviews: [
        { author: { login: "alice" }, state: "APPROVED", submittedAt: "" },
        { author: { login: "bob" }, state: "APPROVED", submittedAt: "" },
      ],
    } as GhPRRaw;
    const reviewers = parsePRReviewers(pr);
    expect(reviewers).not.toContain("alice");
    expect(reviewers).toContain("bob");
  });
  it("excludes bots", () => {
    const pr = {
      author: { login: "alice" },
      reviews: [
        { author: { login: "renovate[bot]" }, state: "APPROVED", submittedAt: "" },
      ],
    } as GhPRRaw;
    expect(parsePRReviewers(pr)).toHaveLength(0);
  });
  it("deduplicates reviewers", () => {
    const pr = {
      author: { login: "alice" },
      reviews: [
        { author: { login: "bob" }, state: "APPROVED", submittedAt: "" },
        { author: { login: "bob" }, state: "COMMENTED", submittedAt: "" },
      ],
    } as GhPRRaw;
    expect(parsePRReviewers(pr)).toHaveLength(1);
  });
});

describe("parsePRReviewerStates", () => {
  it("captures distinct review states per reviewer", () => {
    const pr = {
      author: { login: "alice" },
      reviews: [
        { author: { login: "bob" }, state: "CHANGES_REQUESTED", submittedAt: "" },
        { author: { login: "bob" }, state: "APPROVED", submittedAt: "" },
      ],
    } as GhPRRaw;

    const rows = parsePRReviewerStates(pr);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.login).toBe("bob");
    expect(rows[0]?.states).toContain("CHANGES_REQUESTED");
    expect(rows[0]?.states).toContain("APPROVED");
  });
});

// ── parsePROutcome ────────────────────────────────────────────────────────────

describe("parsePROutcome", () => {
  it("returns 'merged' when mergedAt is set", () => {
    expect(parsePROutcome({ mergedAt: "2024-01-01", state: "MERGED" } as GhPRRaw)).toBe("merged");
  });
  it("returns 'merged' when state is MERGED", () => {
    expect(parsePROutcome({ state: "MERGED" } as GhPRRaw)).toBe("merged");
  });
  it("returns 'open' for open PRs", () => {
    expect(parsePROutcome({ state: "OPEN" } as GhPRRaw)).toBe("open");
  });
  it("returns 'rejected' for CHANGES_REQUESTED closed PR", () => {
    expect(
      parsePROutcome({ state: "CLOSED", reviewDecision: "CHANGES_REQUESTED" } as GhPRRaw)
    ).toBe("rejected");
  });
  it("returns 'abandoned' for closed PR with no review decision", () => {
    expect(parsePROutcome({ state: "CLOSED" } as GhPRRaw)).toBe("abandoned");
  });
});

// ── extractCoChangePairs ──────────────────────────────────────────────────────

describe("extractCoChangePairs", () => {
  it("returns empty for single-file commits", () => {
    expect(extractCoChangePairs([["a.ts"], ["b.ts"]])).toHaveLength(0);
  });

  it("counts pairs across commits", () => {
    const result = extractCoChangePairs([["a.ts", "b.ts"], ["a.ts", "b.ts"]]);
    const pair = result.find((p) => p.fileA === "a.ts" && p.fileB === "b.ts");
    expect(pair?.count).toBe(2);
  });

  it("normalises pair order (fileA < fileB alphabetically)", () => {
    const pairs = extractCoChangePairs([["z.ts", "a.ts"]]);
    expect(pairs[0]?.fileA).toBe("a.ts");
    expect(pairs[0]?.fileB).toBe("z.ts");
  });

  it("returns empty for empty input", () => {
    expect(extractCoChangePairs([])).toHaveLength(0);
  });

  it("handles 3-file commit producing 3 pairs", () => {
    const result = extractCoChangePairs([["a.ts", "b.ts", "c.ts"]]);
    expect(result).toHaveLength(3);
  });
});

// ── buildThreadText (smoke test) ──────────────────────────────────────────────

describe("buildThreadText", () => {
  it("includes issue number and title", () => {
    const issue: GhIssueRaw = {
      number: 42,
      title: "Fix the thing",
      body: "Description here",
      state: "OPEN",
      createdAt: "2024-01-01",
      closedAt: null,
      author: { login: "alice" },
      comments: [],
    };
    const text = buildThreadText(issue);
    expect(text).toContain("ISSUE #42");
    expect(text).toContain("Fix the thing");
  });

  it("filters out bot comments", () => {
    const issue: GhIssueRaw = {
      number: 1,
      title: "T",
      body: "",
      state: "OPEN",
      createdAt: "",
      closedAt: null,
      author: { login: "alice" },
      comments: [
        { author: { login: "renovate[bot]" }, body: "Bot noise", createdAt: "" },
        { author: { login: "bob" }, body: "Human comment", createdAt: "" },
      ],
    };
    const text = buildThreadText(issue);
    expect(text).not.toContain("Bot noise");
    expect(text).toContain("Human comment");
  });
});
