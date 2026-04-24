import { whyLine } from "../../intelligence/why.js";

export const explainLineTool = {
  name: "explain_line",
  description: `Why does this line exist? Traces git blame → commit → PR → design decisions and rejected alternatives. Use before modifying a line.`,
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      file: { type: "string", description: "File path relative to repo root" },
      line: { type: "number", description: "Line number (omit for file-level)" },
    },
    required: ["repo", "file"],
  },
};

export async function handleExplainLine(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const repo = args["repo"] as string | undefined;
  const file = args["file"] as string | undefined;
  const line = args["line"] as number | undefined;

  if (!repo || !file) {
    return {
      content: [{ type: "text", text: "Error: repo and file are required" }],
      isError: true,
    };
  }

  try {
    const result = await whyLine(repo, file, line ?? null);

    const lines: string[] = [];

    if (result.line !== null) {
      lines.push(`## Line ${result.line} of \`${result.file}\``);
    } else {
      lines.push(`## \`${result.file}\``);
    }

    if (result.blame) {
      lines.push(`**Last changed:** \`${result.blame.shortSha}\` by ${result.blame.author} on ${result.blame.date}`);
      lines.push(`**Commit:** "${result.blame.summary}"`);
      if (result.blame.lineContent) {
        lines.push(`**Code:** \`${result.blame.lineContent.slice(0, 100)}\``);
      }
    }

    if (result.fallback) {
      lines.push("", result.fallback);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const pr = result.pr;
    if (!pr) {
      lines.push("", "No PR context found. Run `git-wik index <repo>` first.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const outcomeStr = pr.mergedAt ? `merged ${pr.mergedAt}` : (pr.outcome ?? "unknown");
    lines.push("", `**PR #${pr.number}:** "${pr.title}" [${outcomeStr}]`);
    if (pr.author) lines.push(`**Author:** @${pr.author}`);
    if (pr.reviewers.length > 0) {
      lines.push(`**Reviewers:** ${pr.reviewers.map((r) => `@${r}`).join(", ")}`);
    }
    if (pr.filesChanged.length > 0) {
      const extra = pr.filesChanged.length > 4 ? ` +${pr.filesChanged.length - 4} more` : "";
      lines.push(`**Files changed:** ${pr.filesChanged.slice(0, 4).join(", ")}${extra}`);
    }

    if (pr.why) {
      lines.push("", `**WHY:** ${pr.why}`);
    }
    if (pr.choice) {
      lines.push(`**DECISION:** ${pr.choice}`);
    }
    if (pr.constraints.length > 0) {
      lines.push("", "**Constraints:**");
      for (const c of pr.constraints) lines.push(`- ${c}`);
    }
    if (pr.rejectedAlts.length > 0) {
      lines.push("", "**Rejected alternatives:**");
      for (const r of pr.rejectedAlts) {
        lines.push(`- ~~${r.option}~~${r.reason ? ` — ${r.reason}` : ""}`);
      }
    }
    if (pr.fixesIssues.length > 0) {
      lines.push("", "**Fixes:**");
      for (const i of pr.fixesIssues) {
        lines.push(`- Issue #${i.number} [${i.state.toLowerCase()}]: ${i.title}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
