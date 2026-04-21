# git-wik

> Local knowledge graph for GitHub repos. Gives Claude Code token-efficient answers to "why does this code exist?" instead of making it read thousands of lines of raw PRs and issues.

git-wik builds a local SQLite graph of a GitHub repo's full history — issues, PRs, reviewer decisions, cross-references, and file co-change patterns. When you ask Claude Code to touch a file or implement a feature, it can call git-wik's MCP tool and get a compact, structured answer (~700 tokens) instead of spending its context window reading raw GitHub pages.

---

## Why this exists

When Claude Code starts working on a file, it has no idea:
- Which PRs previously changed that file, and why
- What approaches were tried and rejected
- What constraints maintainers have enforced in reviews
- Which open issues are related to what it's about to touch
- What other files always change together with this one

Without that context, it re-invents decisions that were already made, misses constraints that are implicit in the codebase, and asks you to explain things that are already in the git history.

git-wik pre-builds that context into a queryable graph so Claude Code can retrieve it in one call, within its token budget.

---

## How it works

```
Your GitHub repo
       │
       ▼
git-wik index <repo>          ← fetches via gh CLI, builds local SQLite graph
       │
       ▼
~/.git-wik/<owner>-<repo>/graph.db
       │
       ▼  (on every MCP call)
Hybrid retrieval engine
  ├─ BFS graph traversal      ← follows edges: TOUCHES, FIXES, DEPENDS_ON, REFERENCES
  └─ BM25 full-text search    ← searches indexed issue/PR titles and keywords
       │
       ▼
Scored candidate pool         ← merged, deduplicated, ranked by relevance density
       │
       ▼
Token-budget formatter        ← greedy-fills 700 tokens with highest-signal entities
       │
       ▼
Claude Code                   ← gets ≤700 tokens of structured context
```

### What's in the graph

Every indexed repo gets a SQLite database with:

- **Issues** and **PRs** — titles, state, outcomes, full-text indexed for BM25 search
- **FIXES edges** — which PRs closed which issues (parsed from bodies + commit messages)
- **TOUCHES edges** — which files each PR modified
- **DEPENDS_ON / SUPERSEDES edges** — PR dependency chains
- **CO_CHANGES_WITH edges** — files that change together in commits (from git history)
- **REFERENCES / MENTIONS edges** — cross-references parsed from comment bodies (`fixes #N`, `related to #N`, bare `#N`)
- **REVIEWED_BY edges** — who reviewed each PR, with outcome states
- **LLM-extracted decisions** — WHY a PR made the choice it did (optional, confidence-gated)

### Token efficiency

A typical file query using raw GitHub API calls might consume 5,000–15,000 tokens (PR descriptions, issue threads, review comments). git-wik returns the same information in ≤700 tokens by:

1. **Structural compression** — one line per PR/issue instead of raw thread text
2. **Relevance scoring** — only the highest-signal entities fill the token budget
3. **Evidence-gated inference** — LLM-extracted insights only shown when `confidence ≥ 0.7` AND supporting rationale exists, always marked `[inferred:N.NN]`

---

## Prerequisites

- **Node.js 20+**
- **[GitHub CLI](https://cli.github.com/)** (`gh`) — installed and authenticated (`gh auth login`)
- For LLM enrichment (optional): `ANTHROPIC_API_KEY` or `GOOGLE_GENAI_API_KEY`

---

## Installation

```bash
npm install -g git-wik
```

Or use without installing:

```bash
npx git-wik <command>
```

Maintainers: see `RELEASING.md` for npm publish setup and release steps.

---

## Quick start

**1. Index a repo** (fetches and builds the local graph):

```bash
git-wik index expressjs/express
```

This takes 30–90 seconds for most repos. It fetches all issues and PRs, builds the relationship graph, and runs co-change analysis on recent commits.

**2. Add to Claude Code** (in your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "git-wik": {
      "command": "node",
      "args": ["/path/to/git-wik/dist/mcp/server.js"]
    }
  }
}
```

Or with npx (no global install needed):

```json
{
  "mcpServers": {
    "git-wik": {
      "command": "npx",
      "args": ["-y", "git-wik", "serve"]
    }
  }
}
```

**3. Use in Claude Code**:

```
What changed in src/auth/middleware.ts and why?
```

Claude Code calls `get_context({ repo: "your/repo", query: "src/auth/middleware.ts" })` and gets back a structured answer — no reading raw files, no GitHub API calls.

---

## CLI commands

### `git-wik index [repo]`

Populates the local graph for a repo. Run this before using any MCP tools.

If run from inside a git repo with a GitHub remote, `repo` is auto-detected — you don't need to type it.

```bash
# Auto-detect from current directory (must be inside a GitHub repo)
git-wik index

# Explicit
git-wik index owner/repo

# Options:
git-wik index owner/repo --local-path ./path/to/clone   # faster co-change analysis from local git
git-wik index owner/repo --depth full                    # index all history (default: last 200 items)
git-wik index owner/repo --since 2024-01-01              # only items updated after this date
git-wik index owner/repo --no-enrich                     # skip LLM enrichment (faster, no API key)
git-wik index owner/repo --provider anthropic            # force a specific LLM provider
```

**What it does:**
- Fetches all issues and PRs via `gh` CLI
- Parses relationship edges (FIXES, DEPENDS_ON, REFERENCES, MENTIONS) from bodies and comments
- Builds file co-change pairs from git history
- Optionally runs LLM enrichment on merged PRs to extract decisions and constraints

**Storage:** `~/.git-wik/<owner>-<repo>/graph.db`

---

### `git-wik enrich <repo>`

Runs LLM enrichment over already-indexed PRs to extract design decisions, constraints, and rejected alternatives. Requires `ANTHROPIC_API_KEY` or `GOOGLE_GENAI_API_KEY`.

```bash
git-wik enrich owner/repo

# Options:
git-wik enrich owner/repo --provider anthropic    # or gemini
git-wik enrich owner/repo --force                 # re-enrich already-processed items
git-wik enrich owner/repo --limit 50              # cap at 50 items per run
```

Enrichment is gated to PRs that are likely to have meaningful discussion (merged + substantial body, or has review round-trips). Low-confidence extractions are silently discarded. Results marked `[inferred:N.NN]` in output.

---

### `git-wik status <repo>`

Shows the current state of the local graph for a repo.

```bash
git-wik status owner/repo
```

Output: node counts, edge counts, last indexed timestamp, enrichment coverage.

---

### `git-wik issue <repo> <number>`

Research a specific issue and print structured intelligence (JSON).

```bash
git-wik issue expressjs/express 4321
```

---

### `git-wik file <repo> <path>`

Get the history and design decisions for a specific file (JSON).

```bash
git-wik file expressjs/express src/router/index.js
```

---

### `git-wik why [target]`

Explain why a specific line of code exists. Traces the line through git blame → commit → PR → design decisions.

```bash
# Why does line 42 in this file exist?
git-wik why src/auth/middleware.ts:42

# What's the most recent PR that touched this file?
git-wik why src/auth/middleware.ts

# Options:
git-wik why src/auth/middleware.ts:42 --repo owner/name   # override repo (default: auto-detected)
git-wik why src/auth/middleware.ts:42 --json              # raw JSON output
```

Auto-detects the GitHub repo from your git remote. Output includes:
- The commit SHA, author, and date from `git blame`
- The PR that introduced that commit
- LLM-extracted rationale (confidence-gated, always marked `[inferred]`)
- Rejected alternatives and constraints from the PR discussion

---

### `git-wik serve`

Start the MCP server on stdio. This is what `.mcp.json` calls.

```bash
git-wik serve
```

---

## MCP tools

Once the server is running, Claude Code can call these tools:

---

### `get_context` ★ Start here

**The primary tool.** Accepts any query type and returns a token-budgeted context package.

```
query can be:
  "src/auth/middleware.ts"   → file path
  "#123" or "123"            → issue number
  "pr#456" or "pr456"        → PR number
  "rate limiting"            → keyword / feature name
```

**Example output** (for a file path query):

```
# Context: src/auth/middleware.ts  ·  expressjs/express

## PRs (4 matched)
• PR#5123 "Replace session storage with httpOnly cookies" [merged 2024-01] → fixes #4821
  Review: @dougwilson APPROVED | @wesleytodd CHANGES_REQUESTED→APPROVED (2 rounds)
  [inferred:0.91] WHY: localStorage tokens exposed to XSS; httpOnly prevents JS access
  [inferred:0.87] CHOICE: httpOnly cookies with secure flag + SameSite=Strict
• PR#4987 "Session timeout enforcement" [merged 2023-11]
  Review: @dougwilson APPROVED
• PR#4801 "Initial auth middleware" [merged 2023-08]
  Review: @dougwilson APPROVED | @wesleytodd APPROVED

## Open Issues (2 related)
• #4901 "Session not clearing on logout" [open, 3 comments]
• #5034 "Refresh token race condition" [open]

## Closed Issues
• #4821 "XSS vulnerability in session handling" [closed] ← fixed by PR#5123

## Co-Changed Files (top 3)
• src/session/store.js (8×)
• src/middleware/csrf.js (5×)
• src/types/session.d.ts (4×)
```

Total: ~180 tokens. Reading those PRs and issues raw: ~8,000 tokens.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | string | yes | `"owner/name"` |
| `query` | string | yes | File path, issue#, PR#, or keyword |
| `token_budget` | number | no | Max output tokens (default: 700, max: 900) |

---

### `explain_line`

Explain why a specific line of code exists. Runs `git blame` to find the last commit that touched the line, then looks up the PR that introduced that commit, and returns the full design context: rationale, rejected alternatives, constraints, and linked issues.

**Use this before modifying a line** — it tells you the original intent so you don't accidentally revert a deliberate decision.

**Parameters:** `repo`, `file`, `line` (optional — omit for most-recent PR context for the whole file)

---

### `find_implementation_context`

Pre-implementation research. Given a natural-language description of a change, finds relevant prior PRs, design decisions, and constraints.

```
query: "add rate limiting to the auth middleware"
```

Returns: relevant PRs with outcomes and file lists, design decisions with rationale, constraints, rejected alternatives.

**Parameters:** `repo`, `query`, `max_prs` (default: 3), `max_files` (default: 3)

---

### `research_issue`

Full intelligence on a specific issue: linked PRs, contributors, discussion summary.

**Parameters:** `repo`, `issue_number`

---

### `get_file_lore`

Design history for a specific file: PRs that touched it, decisions extracted from those PRs, constraints, and files that co-change with it.

**Parameters:** `repo`, `file_path`

---

### `find_similar`

BM25 similarity search. Find issues or PRs that are similar to a query — useful for detecting duplicates or finding prior art.

**Parameters:** `repo`, `query`, `limit` (default: 5, max: 10)

---

### `get_pr_context`

Full context for a specific PR: what it changed, why, what was rejected, what constraints it enforced.

**Parameters:** `repo`, `pr_number`

---

## How the retrieval works

When `get_context` receives a query, it runs two passes in parallel and merges them:

### Pass 1 — Structural BFS

Traverses the graph starting from the detected seed type:

- **File seed** → finds all PRs that touched that file (`TOUCHES` edges reverse), then their linked PRs (`DEPENDS_ON`)
- **Issue seed** → finds PRs that fix the issue (`FIXES` edges reverse), plus cross-referenced issues (`REFERENCES`/`MENTIONS` edges)
- **PR seed** → finds issues it fixes, linked PRs, and files it changed
- **Keyword seed** → skips BFS (no structural anchor), goes straight to FTS

### Pass 2 — BM25 full-text search

Runs in parallel regardless of seed type. Searches BM25-indexed issue/PR titles and keywords. Returns top 15 matches.

### Merge + score

Results from both passes are merged by entity ID. Each entity gets a score:

```
score = (DISTANCE_BASE − distance) × mergeWeight × recencyScore + FTS_MATCH_BONUS
```

- `distance` — 0 for the seed itself, 1 for direct edges, 2 for two-hop edges
- `mergeWeight` — 3 for merged PRs, 2 for open, 1 for closed-no-merge
- `recencyScore` — 1 / (1 + daysSince / 180), half-life of 6 months
- `FTS_MATCH_BONUS` — +0.5 if the entity appeared in **both** BFS and FTS results

Items appearing in both passes get a natural boost, rising to the top of the ranking.

### Token budget greedy fill

Sorted by score, entities fill the token budget greedily until the limit (~700 tokens by default) is reached. The formatter reserves ~30 tokens for the header.

### Seed fallback

If a file/issue/PR seed is not found in the index (e.g., the repo hasn't been indexed, or the entity doesn't exist), the query is automatically retried as a keyword search. The output notes that this happened.

---

## LLM enrichment

Enrichment is **optional** and only improves the `[inferred:N.NN]` lines in `get_context` output. The structural graph works without any API key.

When enrichment runs on a PR, it sends the PR thread to an LLM (Claude Haiku or Gemini) and extracts:
- Problem statement (why the PR was made)
- Choice made (what approach was taken)
- Rationale (why that approach)
- Constraints discovered
- Alternatives that were rejected

**Quality gate:** Extracted data is only surfaced when:
1. `confidence ≥ 0.7` (LLM's self-assessed confidence)
2. A supporting `rationale` was extracted (not just a bare claim)

Items that pass both gates are shown as `[inferred:0.87] WHY: ...`. Items that fail are silently counted and reported in the footer as `*N inferred items omitted (low evidence)*`. This prevents confidently-wrong data from appearing.

Enrichment uses Anthropic's [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) to reduce the cost of the system prompt across bulk runs (~90% cache hit rate after warmup).

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Enables Claude Haiku LLM enrichment |
| `GOOGLE_GENAI_API_KEY` | Enables Gemini LLM enrichment (fallback) |

Neither variable is required for indexing or MCP queries. Only needed for `git-wik enrich`.

---

## Data storage

All data is stored locally. Nothing is sent to any server except:
- GitHub API calls (via `gh` CLI, using your existing `gh` credentials)
- LLM API calls during `git-wik enrich` (only if you set an API key)

Graphs are stored at:
```
~/.git-wik/<owner>-<repo>/graph.db
```

Each repo gets its own SQLite database. You can delete it at any time; `git-wik index` will rebuild from scratch.

---

## Limitations

- **Read-only**: git-wik only reads GitHub data. It has no write path.
- **Public repos / authenticated access**: Uses `gh` CLI, so it respects your GitHub authentication. Works on private repos if your `gh` session has access.
- **Index freshness**: The repo index has a 24-hour TTL. Run `git-wik index` again to refresh.
- **LLM extraction quality**: Inferred content can be wrong. The confidence + evidence gate reduces noise but doesn't eliminate it. Always verify inferred items against the actual PR.
- **Large repos**: The default `index` fetches up to 200 recent items. Use `--depth full` for complete history (slower).

---

## Development

```bash
git clone https://github.com/your-org/git-wik
cd git-wik
npm install
npm run dev -- index expressjs/express   # run CLI without building
npm test                                  # vitest
npm run typecheck                         # tsc --noEmit
npm run build                             # compile to dist/
```

### Project structure

```
src/
  graph/          SQLite schema, migrations, DB helpers, BM25 FTS
  fetcher/        GitHub API wrappers, parse.ts, populate.ts, cochange.ts
  extract/        LLM enrichment (Anthropic + Gemini providers)
  intelligence/   Retrieval engine: context.ts, context-formatter.ts
  mcp/            MCP server + tool handlers
  cli/            Commander CLI wrapper
  shared/         token-budget.ts, keywords.ts
```

Key files:
- `src/intelligence/context.ts` — Hybrid BFS+FTS retrieval, scoring algorithm, seed detection
- `src/intelligence/context-formatter.ts` — Token-budget greedy formatter
- `src/fetcher/parse.ts` — All regex parsing (relationships, cross-references)
- `src/graph/db.ts` — All SQLite node/edge types and upsert/query helpers
