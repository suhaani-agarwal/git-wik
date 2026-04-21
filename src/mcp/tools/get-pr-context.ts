import {
  getDb,
  getPR,
  getDecision,
  getConstraint,
  getEdgesFrom,
} from "../../graph/db.js";
import { formatPRContext, type PRContextData } from "../../intelligence/formatter.js";
import { truncateAt } from "../../shared/token-budget.js";

export const getPRContextTool = {
  name: "get_pr_context",
  description: `Get structured intelligence for a specific pull request.
Returns the PR's problem statement, chosen approach, files changed, design decisions, constraints, and rejected alternatives.
Use this when you know a specific PR number is relevant and want its full decision context.
Requires the repo to have been indexed with \`git-wik index <repo>\`.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: 'GitHub repo in "owner/name" format, e.g. "expressjs/express"',
      },
      pr_number: {
        type: "number",
        description: "The pull request number",
      },
    },
    required: ["repo", "pr_number"],
  },
} as const;

export async function handleGetPRContext(args: Record<string, unknown>) {
  const repo = args["repo"] as string | undefined;
  const prNumber = args["pr_number"] as number | undefined;

  if (!repo || typeof repo !== "string") {
    return { content: [{ type: "text" as const, text: 'Error: missing or invalid `repo` (expected "owner/name")' }], isError: true };
  }
  if (!prNumber || typeof prNumber !== "number") {
    return { content: [{ type: "text" as const, text: "Error: missing or invalid `pr_number`" }], isError: true };
  }
  if (!repo.includes("/")) {
    return { content: [{ type: "text" as const, text: `Error: repo must be "owner/name", got: ${repo}` }], isError: true };
  }

  try {
    const db = getDb(repo);
    const prId = `${repo}#pr#${prNumber}`;
    const pr = getPR(db, prId);

    if (!pr) {
      return {
        content: [{ type: "text" as const, text: `PR #${prNumber} not found in graph for ${repo}. Run \`git-wik index ${repo}\` to populate.` }],
        isError: true,
      };
    }

    // ── Files changed ────────────────────────────────────────────────────────
    const fileEdges = getEdgesFrom(db, "pr", pr.id, "TOUCHES");
    const files_changed = fileEdges
      .map((e) => e.to_id.replace(`${repo}::`, ""))
      .slice(0, 10);

    // ── Design decisions (PRODUCED edges) ────────────────────────────────────
    const design_decisions: PRContextData["design_decisions"] = [];
    const decisionSeen = new Set<string>();

    const decEdges = getEdgesFrom(db, "pr", pr.id, "PRODUCED");
    for (const de of decEdges) {
      if (decisionSeen.has(de.to_id)) continue;
      const d = getDecision(db, de.to_id);
      if (d) {
        decisionSeen.add(d.id);
        design_decisions.push({
          problem: truncateAt(d.problem, 120),
          choice: truncateAt(d.choice, 150),
          rationale: d.rationale ? truncateAt(d.rationale, 150) : null,
          confidence: d.confidence,
        });
      }
    }

    // ── Constraints (REQUIRES edges) ─────────────────────────────────────────
    const constraints: string[] = [];
    const cEdges = getEdgesFrom(db, "pr", pr.id, "REQUIRES");
    for (const ce of cEdges) {
      const c = getConstraint(db, ce.to_id);
      if (c) constraints.push(truncateAt(c.text, 100));
    }

    // ── Rejected alternatives (REJECTS edges) ────────────────────────────────
    const rejected_alternatives: PRContextData["rejected_alternatives"] = [];
    const rEdges = getEdgesFrom(db, "pr", pr.id, "REJECTS");
    for (const re of rEdges) {
      const ra = db
        .prepare("SELECT * FROM rejected_alternatives WHERE id=?")
        .get(re.to_id) as { option_text: string; rejection_reason: string | null } | undefined;
      if (ra) {
        rejected_alternatives.push({
          option: truncateAt(ra.option_text, 100),
          reason: ra.rejection_reason ? truncateAt(ra.rejection_reason, 100) : null,
        });
      }
    }

    // ── Also pull inline enrichment JSON from body_summary ───────────────────
    if (pr.body_summary?.startsWith("{")) {
      try {
        const inline = JSON.parse(pr.body_summary) as {
          problem?: string | null;
          choice?: string | null;
          rationale?: string | null;
          confidence?: number;
          constraints?: string[];
          rejected?: Array<{ option: string; reason?: string | null }>;
        };

        if (inline.choice && !design_decisions.some((d) => d.choice === inline.choice)) {
          design_decisions.push({
            problem: inline.problem ? truncateAt(inline.problem, 120) : "Not specified",
            choice: truncateAt(inline.choice, 150),
            rationale: inline.rationale ? truncateAt(inline.rationale, 150) : null,
            confidence: inline.confidence ?? 0.5,
          });
        }
        for (const c of inline.constraints ?? []) {
          const t = truncateAt(c, 100);
          if (!constraints.includes(t)) constraints.push(t);
        }
        for (const r of inline.rejected ?? []) {
          if (r.option) {
            rejected_alternatives.push({
              option: truncateAt(r.option, 100),
              reason: r.reason ? truncateAt(r.reason, 100) : null,
            });
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }

    // ── Approach from enrichment ──────────────────────────────────────────────
    let approach: string | null = null;
    if (design_decisions.length > 0) {
      approach = design_decisions[0]!.choice;
    }

    const ctx: PRContextData = {
      repo,
      number: pr.number,
      title: pr.title,
      outcome: pr.outcome,
      approach,
      files_changed,
      design_decisions: design_decisions.slice(0, 5),
      constraints: constraints.slice(0, 5),
      rejected_alternatives: rejected_alternatives.slice(0, 4),
    };

    return { content: [{ type: "text" as const, text: formatPRContext(ctx) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error fetching PR context: ${msg}` }], isError: true };
  }
}
