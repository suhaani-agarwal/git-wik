import {
  getDb,
  getPR,
  getDecision,
  getConstraint,
  getEdgesFrom,
  getEdgesTo,
} from "../graph/db.js";

export interface FileLore {
  path: string;
  prs: Array<{
    number: number;
    title: string;
    outcome: string | null;
  }>;
  decisions: Array<{
    problem: string;
    choice: string;
    rationale: string | null;
    confidence: number;
  }>;
  constraints: string[];
  co_changes: Array<{
    path: string;
    count: number;
  }>;
}

export async function getFileLore(
  repo: string,
  filePath: string
): Promise<FileLore> {
  const db = getDb(repo);
  const fileId = `${repo}::${filePath}`;

  // ── PRs that touch this file ───────────────────────────────────────────────
  const touchEdges = getEdgesTo(db, "file", fileId, "TOUCHES");
  const prs = touchEdges
    .map((e) => {
      const pr = getPR(db, e.from_id);
      if (!pr) return null;
      return {
        number: pr.number,
        title: pr.title,
        outcome: pr.outcome,
      };
    })
    .filter(Boolean) as FileLore["prs"];

  // ── Decisions from those PRs ───────────────────────────────────────────────
  const decisionSet = new Map<
    string,
    { problem: string; choice: string; rationale: string | null; confidence: number }
  >();

  for (const e of touchEdges) {
    const decEdges = getEdgesFrom(db, "pr", e.from_id, "PRODUCED");
    for (const de of decEdges) {
      if (decisionSet.has(de.to_id)) continue;
      const d = getDecision(db, de.to_id);
      if (d) {
        decisionSet.set(d.id, {
          problem: d.problem,
          choice: d.choice,
          rationale: d.rationale,
          confidence: d.confidence,
        });
      }
    }
  }

  // ── Constraints from those PRs ─────────────────────────────────────────────
  const constraintIds = new Set<string>();
  for (const e of touchEdges) {
    const cEdges = getEdgesFrom(db, "pr", e.from_id, "REQUIRES");
    for (const ce of cEdges) constraintIds.add(ce.to_id);
  }

  const constraints = [...constraintIds]
    .map((cid) => getConstraint(db, cid))
    .filter(Boolean)
    .map((c) => c!.text);

  // ── Co-change partners ─────────────────────────────────────────────────────
  const coEdgesFrom = getEdgesFrom(db, "file", fileId, "CO_CHANGES_WITH");
  const coEdgesTo = getEdgesTo(db, "file", fileId, "CO_CHANGES_WITH");

  const coChangeMap = new Map<string, number>();
  for (const e of coEdgesFrom) {
    coChangeMap.set(e.to_id, (coChangeMap.get(e.to_id) ?? 0) + e.weight);
  }
  for (const e of coEdgesTo) {
    coChangeMap.set(e.from_id, (coChangeMap.get(e.from_id) ?? 0) + e.weight);
  }

  const co_changes = [...coChangeMap.entries()]
    .map(([id, count]) => ({
      path: id.replace(`${repo}::`, ""),
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    path: filePath,
    prs,
    decisions: [...decisionSet.values()],
    constraints,
    co_changes,
  };
}
