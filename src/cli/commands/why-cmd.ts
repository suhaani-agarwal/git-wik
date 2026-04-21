import type { Command } from "commander";
import { whyLine } from "../../intelligence/why.js";
import { detectRepoFromCwd } from "../../shared/detect-repo.js";

function formatWhyOutput(result: Awaited<ReturnType<typeof whyLine>>): string {
  const lines: string[] = [];
  const divider = "─".repeat(50);

  // ── Header ──
  if (result.line !== null) {
    lines.push(`\nLine ${result.line} of ${result.file}`);
  } else {
    lines.push(`\n${result.file}`);
  }

  if (result.blame) {
    lines.push(`Last changed: commit ${result.blame.shortSha} by ${result.blame.author} on ${result.blame.date}`);
    lines.push(`  "${result.blame.summary}"`);
    if (result.blame.lineContent) {
      lines.push(`  Code: ${result.blame.lineContent.slice(0, 80)}`);
    }
  }

  lines.push(divider);

  // ── Fallback ──
  if (result.fallback) {
    lines.push(result.fallback);
    return lines.join("\n");
  }

  // ── PR context ──
  const pr = result.pr;
  if (!pr) {
    lines.push("No PR context found. Try running `git-wik index <repo>` first.");
    return lines.join("\n");
  }

  const outcomeStr = pr.mergedAt ? `merged ${pr.mergedAt}` : (pr.outcome ?? pr.outcome ?? "unknown");
  lines.push(`PR #${pr.number}: "${pr.title}" [${outcomeStr}]`);
  if (pr.author) lines.push(`by @${pr.author}`);

  if (pr.reviewers.length > 0) {
    lines.push(`Reviewed by: ${pr.reviewers.map((r) => `@${r}`).join(", ")}`);
  }

  if (pr.filesChanged.length > 0) {
    lines.push(`Files changed: ${pr.filesChanged.slice(0, 4).join(", ")}${pr.filesChanged.length > 4 ? ` +${pr.filesChanged.length - 4} more` : ""}`);
  }

  // ── WHY ──
  if (pr.why) {
    lines.push("");
    lines.push("WHY THIS CHANGED:");
    lines.push(`  ${pr.why}`);
  }

  if (pr.choice) {
    lines.push("");
    lines.push("WHAT WAS DECIDED:");
    lines.push(`  ${pr.choice}`);
  }

  // ── Constraints ──
  if (pr.constraints.length > 0) {
    lines.push("");
    lines.push("CONSTRAINTS:");
    for (const c of pr.constraints) lines.push(`  • ${c}`);
  }

  // ── Rejected alternatives ──
  if (pr.rejectedAlts.length > 0) {
    lines.push("");
    lines.push("REJECTED APPROACHES:");
    for (const r of pr.rejectedAlts) {
      lines.push(`  ✗ ${r.option}${r.reason ? ` — ${r.reason}` : ""}`);
    }
  }

  // ── Fixes ──
  if (pr.fixesIssues.length > 0) {
    lines.push("");
    lines.push("FIXES:");
    for (const i of pr.fixesIssues) {
      lines.push(`  Issue #${i.number} [${i.state.toLowerCase()}]: ${i.title}`);
    }
  }

  if (!pr.why && !pr.choice && pr.constraints.length === 0) {
    lines.push("");
    lines.push("(No LLM-extracted context available. Run `git-wik enrich <repo>` to add design rationale.)");
  }

  lines.push("");
  return lines.join("\n");
}

export function registerWhyCommand(program: Command): void {
  program
    .command("why [target]")
    .description(
      'Explain why a line exists. Target: "<file>:<line>" or just "<file>".\n' +
      "  Examples:\n" +
      "    git-wik why src/auth/middleware.ts:42\n" +
      "    git-wik why src/auth/middleware.ts\n" +
      "  Repo is auto-detected from git remote. Use --repo to override."
    )
    .option("--repo <owner/repo>", "GitHub repo (default: auto-detected from git remote)")
    .option("--json", "Output raw JSON instead of formatted text")
    .action(async (target: string | undefined, opts: { repo?: string; json?: boolean }) => {
      if (!target) {
        console.error(
          "\nUsage: git-wik why <file>[:<line>]\n\n" +
          "  git-wik why src/auth/middleware.ts:42\n" +
          "  git-wik why src/auth/middleware.ts\n"
        );
        process.exit(1);
      }

      // Parse file:line or just file
      let filePath: string;
      let lineNumber: number | null = null;

      const colonIdx = target.lastIndexOf(":");
      if (colonIdx > 0) {
        const maybeLine = target.slice(colonIdx + 1);
        const n = parseInt(maybeLine, 10);
        if (!isNaN(n) && n > 0 && String(n) === maybeLine) {
          filePath = target.slice(0, colonIdx);
          lineNumber = n;
        } else {
          filePath = target; // Windows-style path or no line number
        }
      } else {
        filePath = target;
      }

      // Resolve repo
      let repo = opts.repo;
      if (!repo) {
        repo = (await detectRepoFromCwd()) ?? undefined;
        if (!repo) {
          console.error(
            "\nCould not detect GitHub repo from git remote.\n" +
            "Run from inside a git repo, or use --repo owner/name\n"
          );
          process.exit(1);
        }
      }

      try {
        process.stderr.write(`Looking up ${filePath}${lineNumber !== null ? `:${lineNumber}` : ""} in ${repo}…\n`);
        const result = await whyLine(repo, filePath, lineNumber);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatWhyOutput(result));
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
