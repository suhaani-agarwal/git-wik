# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # run CLI directly via tsx (no build required)
npm run build        # compile with tsup → dist/
npm run typecheck    # tsc --noEmit (no emit, type errors only)
npm test             # vitest run
```

Run a specific CLI command without building:
```bash
npx tsx src/cli/index.ts index                          # auto-detect repo from git remote
npx tsx src/cli/index.ts index <owner/repo>
npx tsx src/cli/index.ts doctor
npx tsx src/cli/index.ts init-mcp
npx tsx src/cli/index.ts why src/auth/middleware.ts:42  # blame + PR context for a line
npx tsx src/cli/index.ts why src/auth/middleware.ts     # most recent PR for the file
npx tsx src/cli/index.ts issue <owner/repo> <number>
npx tsx src/cli/index.ts file <owner/repo> <path>
npx tsx src/cli/index.ts serve
```

Agent policy template for MCP-first usage is documented in `docs/AGENT_USAGE.md`.

The MCP server (for use via `.mcp.json`) runs the built output:
```bash
node dist/mcp/server.js
```

## Local verification flow

Use this sequence before releases or major refactors:

```bash
npm run typecheck
npm test
npx tsx src/cli/index.ts doctor
npx tsx src/cli/index.ts init-mcp --print
```

Expected:
- Typecheck/test pass
- `doctor` should print `PASS` for Node and `gh` checks
- `init-mcp --print` should emit JSON with:
  - `mcpServers.git-wik.command = "npx"`
  - `mcpServers.git-wik.args = ["-y", "git-wik", "serve"]`

## Architecture

The system is a **read-only intelligence layer** over GitHub history. It has no write path. The flow is:

```
MCP tool call / CLI
  → intelligence/  (assemble answer from graph)
  → fetcher/       (populate graph if stale, via gh CLI)
  → graph/db.ts    (SQLite upserts + queries)
```

### Layers

**`src/graph/`** — The SQLite schema and all DB helpers. One database per repo, stored at `~/.git-wik/<owner>-<repo>/graph.db`. `db.ts` exports typed upsert/query functions and the `getDb(repo)` singleton. The schema uses a generic `edges` table for all relationships (typed by `edge_type`). TTL-based freshness is tracked in `sync_state`.
- `migrations.ts` — Schema V1 (base tables) + V2 (FTS5 indexes, commits, labels, milestones). Run automatically on `getDb()`.
- `fts.ts` — BM25 full-text search (`searchIssues`, `searchPRs`, `searchAll`, `searchFilesByPath`, `findCoClusteredItems`).

**`src/fetcher/`** — Three files with distinct roles:
- `gh.ts` — raw `gh` CLI wrappers, all returning typed structs
- `parse.ts` — pure parsing/transformation functions: regex extraction for issue/PR relationships, thread builders, co-change pair computation, `parseMentions` for cross-reference edges (`MENTIONS`/`REFERENCES`) from comment bodies
- `populate.ts` — orchestrates fetching and writing to the graph; TTL check (`isStale`) lives here; caches 2h per issue/PR, 24h for repo index
- `cochange.ts` — git log parsing and file co-change edge (`CO_CHANGES_WITH`) population

**`src/extract/`** — Optional LLM enrichment using `claude-haiku-4-5-20251001`. `extract.ts` dynamically imports `@anthropic-ai/sdk` (a devDependency) so the MCP server works without it when installed via `npx`. Returns `EMPTY_RESULT` if `ANTHROPIC_API_KEY` is absent or the SDK isn't installed.
- `providers/anthropic.ts` — Claude Haiku extraction with Anthropic prompt caching
- `providers/gemini.ts` — Google GenAI fallback
- `factory.ts` — auto-detects provider from env vars

**`src/intelligence/`** — Query and formatting layer:
- `context.ts` — **Core retrieval engine.** `detectSeed(query)` classifies a query as file/issue/PR/keyword. `traverseFromSeed` runs hybrid BFS graph traversal + FTS/BM25 search, merges results into a unified scored candidate pool, and applies seed fallback (retries as keyword if structural seed not found). Scoring formula: `(DISTANCE_BASE − distance) × mergeWeight × recencyScore + FTS_MATCH_BONUS`. All scoring constants exported as `SCORE_WEIGHTS`.
- `context-formatter.ts` — Token-budget greedy formatter. `formatContextPackage` assembles compact Markdown (≤700 tokens by default) from a `TraversalResult`. LLM-inferred items shown only when `confidence ≥ 0.7 AND rationale IS NOT NULL`, always marked `[inferred:N.NN]`. Omitted low-evidence count reported in footer.
- `implementation-context.ts` — `findImplementationContext` uses `context.ts` traversal internally; keeps `ImplementationContext` return shape for backwards compatibility with the `find_implementation_context` MCP tool.
- `issue.ts` — `researchIssue`: assembles `IssueIntelligence` from graph traversals.
- `file-lore.ts` — `getFileLore`: traverses `TOUCHES`→PR→`PRODUCED`→Decision and `CO_CHANGES_WITH` edges.
- `formatter.ts` — Markdown formatters for each response type; uses `formatWithBudget` from `shared/token-budget.ts`.

**`src/mcp/server.ts`** — MCP server exposing 7 tools. Formats graph results into Markdown. Loaded lazily by CLI's `serve` subcommand. Tools (in order of priority):
1. `get_context` — **Unified tool.** Accepts file path, issue#, PR#, or keyword. Returns ≤700 token context package with PRs, issues, co-changed files, and gated inferences.
2. `explain_line` — git blame → commit → PR → design rationale for a specific line. Use before modifying a line.
3. `research_issue` — Full issue intelligence with related PRs and contributors.
4. `get_file_lore` — File history: PRs, decisions, constraints, co-change partners.
5. `find_implementation_context` — Pre-implementation context (keyword-only, legacy).
6. `find_similar` — BM25 similarity search for issues/PRs.
7. `get_pr_context` — Full PR context: decisions, constraints, rejected alternatives.

**`src/cli/index.ts`** — Thin Commander wrapper. `serve` uses dynamic `import()` to avoid loading MCP SDK in CLI-only flows. Commands include `index`, `enrich`, `status`, `why`, `doctor`, and `init-mcp`.

**`src/cli/commands/why-cmd.ts`** — `registerWhyCommand`: `git-wik why <file>[:<line>]`. Auto-detects repo from git remote.

**`src/cli/commands/doctor-cmd.ts`** — `registerDoctorCommand`: checks Node, `gh`, auth status, repo detection, local DB, and MCP config presence.

**`src/cli/commands/init-mcp-cmd.ts`** — `registerInitMcpCommand`: creates/updates `.mcp.json` with a default `git-wik` MCP server entry.

**`src/intelligence/why.ts`** — `whyLine(repo, file, line)`: git blame → `fetchCommitPRs` → `assemblePRContext`. Falls back to file-level most-recent-PR if no line given. `blameFileLine` runs `git blame -L N,N --porcelain`.

**`src/shared/detect-repo.ts`** — `detectRepoFromCwd()`: parses `git remote get-url origin` for GitHub owner/repo. Supports both HTTPS and SSH remotes.

### Edge types

| Edge | From → To | Meaning |
|------|-----------|---------|
| `FIXES` | pr → issue | PR fixes/closes issue |
| `DEPENDS_ON` | pr → pr | PR depends on another |
| `SUPERSEDES` | pr → pr | PR supersedes another |
| `TOUCHES` | pr → file | PR modified file |
| `CO_CHANGES_WITH` | file → file | Files changed together (weighted) |
| `AUTHORED_BY` | issue\|pr → contributor | Author |
| `COMMENTED_BY` | issue → contributor | Commenter |
| `REVIEWED_BY` | pr → contributor | Reviewer (metadata_json has states) |
| `PRODUCED` | pr → decision | PR produced a design decision |
| `REQUIRES` | pr → constraint | PR requires a constraint |
| `REJECTS` | pr → rejected_alternative | PR rejected an approach |
| `HAS_LABEL` | issue\|pr → label | Label membership |
| `IN_MILESTONE` | issue\|pr → milestone | Milestone membership |
| `REFERENCES` | issue\|pr → issue | Explicit cross-reference in body/comments (`fixes #N`, `related to #N`) |
| `MENTIONS` | issue\|pr → issue | Bare `#N` mention in body/comments |

### Node/edge ID conventions

| Entity | ID format |
|--------|-----------|
| Issue  | `{repo}#{number}` |
| PR     | `{repo}#pr#{number}` |
| File   | `{repo}::{path}` |
| Contributor | `{repo}::{username}` |
| Label | `{repo}::{name}` |
| Milestone | `{repo}::milestone::{number}` |

### Build outputs

`tsup` produces two separate ESM bundles:
- `dist/cli/index.js` — gets `#!/usr/bin/env node` banner prepended
- `dist/mcp/server.js` — imported dynamically at runtime

`@anthropic-ai/sdk` is a devDependency intentionally — it must not appear in the production bundle.
