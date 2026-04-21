# git-wiki
### Institutional memory for any GitHub repository — as an MCP server for Claude Code

---

## The one-sentence pitch

git-wiki builds a local relation graph of your GitHub repo's entire history — every issue, PR, review, file, decision, and contributor — and serves it to Claude Code via MCP as surgical, token-efficient answers in under 100ms.

---

## The core insight: the graph IS the product

Every other approach either:
- **Raw access** (GitHub MCP, `gh` CLI): returns unprocessed data — 5,000–30,000 tokens of noise per call
- **Pre-fetch everything**: 15-minute init, goes stale, doesn't scale to repos you don't own
- **On-demand LLM extraction**: right idea but still slow for deep questions, no cross-entity reasoning

git-wiki's approach: **build a relation graph once per repo, traverse it instantly.**

The graph nodes are: Issues, PRs, Files, Decisions, Constraints, Contributors.
The graph edges are: `FIXES`, `TOUCHES`, `CO_CHANGES_WITH`, `PRODUCED`, `GOVERNED_BY`, `MADE_BY`, `RESOLVES`, `REFERENCED_BY`.

When Claude Code asks "why is `src/auth/jwt.ts` written this way?", git-wiki traverses:
```
File → [GOVERNED_BY] → Decision → [PRODUCED] → PR → [REFERENCED_BY] → Issue
                                              → [REVIEWED_BY] → Contributor (who made the call)
```
That traversal is 3 SQL joins. Returns in <10ms. Costs ~400 tokens. 

Without git-wiki: Claude Code calls `gh`, reads 15,000 tokens of raw text, spends 8,000 more tokens reasoning about it, takes 2 minutes.

---

## What git-wiki is NOT

- Not a GitHub API client — uses `gh` CLI (already in Claude Code's environment)
- Not a code indexer — doesn't parse source files, doesn't need tree-sitter
- Not a pre-fetch tool — on-demand graph population with aggressive caching
- Not a separate app with its own UI (that's v2) — MCP server + CLI only in v1
- Not a replacement for GitHub's official MCP — complement to it. GitHub MCP does raw operations (create PR, comment, etc.). git-wiki does intelligence (why, history, patterns)

---

## The relation graph schema

Built on SQLite with an edge table. No external graph DB. SQLite handles 2-3 hop traversals on 50,000 node graphs in under 5ms.

### Node tables

```sql
-- Primary entities (nodes)
CREATE TABLE issues (
  id TEXT PRIMARY KEY,          -- "{repo}#{number}" e.g. "expressjs/express#2841"
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'open' | 'closed'
  body_summary TEXT,            -- LLM-extracted 1-sentence summary
  created_at INTEGER,
  closed_at INTEGER,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT                 -- cached raw gh output
);

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,          -- "{repo}#pr#{number}"
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'open' | 'merged' | 'closed'
  outcome TEXT,                 -- 'merged' | 'rejected' | 'abandoned' | 'superseded'
  body_summary TEXT,            -- LLM-extracted 1-sentence summary
  merged_at INTEGER,
  closed_at INTEGER,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,          -- "{repo}::{path}" e.g. "expressjs/express::src/auth/jwt.ts"
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,          -- UUID generated at extraction time
  repo TEXT NOT NULL,
  problem TEXT NOT NULL,        -- what problem was being solved
  choice TEXT NOT NULL,         -- what was chosen
  rationale TEXT,               -- why this choice (may be null if not stated)
  confidence REAL NOT NULL,     -- 0.0-1.0: how clearly was this a decision
  extracted_at INTEGER NOT NULL
);

CREATE TABLE constraints (
  id TEXT PRIMARY KEY,          -- UUID
  repo TEXT NOT NULL,
  text TEXT NOT NULL,           -- the constraint as stated ("must work without Redis")
  status TEXT NOT NULL,         -- 'active' | 'possibly_stale' | 'resolved'
  status_checked_at INTEGER
);

CREATE TABLE contributors (
  id TEXT PRIMARY KEY,          -- "{repo}::{username}"
  repo TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT
);

CREATE TABLE rejected_alternatives (
  id TEXT PRIMARY KEY,          -- UUID
  pr_id TEXT NOT NULL,
  option_text TEXT NOT NULL,    -- what was proposed
  rejection_reason TEXT,        -- why it was rejected (null if implicit)
  rejected_by TEXT              -- username if identifiable
);
```

### Edge table (the graph)

```sql
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type TEXT NOT NULL,      -- 'issue'|'pr'|'file'|'decision'|'constraint'|'contributor'
  from_id TEXT NOT NULL,        -- references the appropriate node table
  edge_type TEXT NOT NULL,      -- see edge types below
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  weight REAL DEFAULT 1.0,      -- for co-change: frequency count; for others: 1.0
  metadata_json TEXT,           -- edge-specific data (e.g., line_count for file touches)
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_edges_from ON edges(from_type, from_id, edge_type);
CREATE INDEX idx_edges_to ON edges(to_type, to_id, edge_type);
CREATE INDEX idx_edges_type ON edges(edge_type);
```

### Edge types

| edge_type | from | to | meaning |
|---|---|---|---|
| `FIXES` | issue | pr | This PR was opened to fix this issue |
| `REFERENCES` | issue | issue | Issue mentions another issue |
| `TOUCHES` | pr | file | This PR modified this file |
| `PRODUCED` | pr | decision | This PR thread produced this architectural decision |
| `PRODUCED` | issue | decision | This issue thread produced this architectural decision |
| `GOVERNED_BY` | file | decision | This decision applies to this file |
| `REQUIRES` | decision | constraint | This decision was made because of this constraint |
| `RESOLVES` | pr | constraint | This PR resolved/changed this constraint |
| `REJECTS` | pr | rejected_alternative | This PR explicitly rejected this option |
| `REVIEWED_BY` | pr | contributor | This contributor reviewed this PR |
| `AUTHORED_BY` | pr | contributor | This contributor opened this PR |
| `AUTHORED_BY` | issue | contributor | This contributor opened this issue |
| `OWNS` | contributor | file | This contributor has high blame % on this file |
| `CO_CHANGES_WITH` | file | file | These files change together frequently (weight = co-change count) |
| `SUPERSEDED_BY` | decision | decision | Older decision replaced by newer one |

---

## Graph traversal patterns (what the MCP tools actually run)

### Pattern 1: File Lore (most used)
"What do I need to know before touching `src/auth/jwt.ts`?"

```sql
-- Step 1: Get all decisions governing this file
SELECT d.*, e.weight 
FROM edges e 
JOIN decisions d ON d.id = e.to_id
WHERE e.from_type = 'file' 
  AND e.from_id = 'expressjs/express::src/auth/jwt.ts'
  AND e.edge_type = 'GOVERNED_BY'
ORDER BY e.weight DESC;

-- Step 2: For each decision, get its constraints and their status
SELECT c.*, e2.edge_type
FROM edges e2
JOIN constraints c ON c.id = e2.to_id
WHERE e2.from_type = 'decision'
  AND e2.from_id IN (/* decision ids from step 1 */)
  AND e2.edge_type = 'REQUIRES';

-- Step 3: Get co-change partners
SELECT f.path, e3.weight as co_change_count
FROM edges e3
JOIN files f ON f.id = e3.to_id
WHERE e3.from_type = 'file'
  AND e3.from_id = 'expressjs/express::src/auth/jwt.ts'
  AND e3.edge_type = 'CO_CHANGES_WITH'
ORDER BY e3.weight DESC
LIMIT 5;
```

3 queries. Returns in <5ms. Result: ~400 tokens of structured intelligence.

### Pattern 2: Issue Research (OSS contributor workflow)
"What do I need to know to work on issue #2841?"

```sql
-- Step 1: Get all PRs that fix or reference this issue
SELECT pr.*, e.edge_type
FROM edges e
JOIN pull_requests pr ON pr.id = e.from_id
WHERE e.to_type = 'issue'
  AND e.to_id = 'expressjs/express#2841'
  AND e.edge_type IN ('FIXES', 'REFERENCES');

-- Step 2: Find similar historical PRs via shared file touches
-- (find PRs that touched the same files as mentioned in the issue body)
SELECT pr.*, COUNT(*) as shared_files
FROM edges e1
JOIN edges e2 ON e2.to_id = e1.to_id AND e2.from_type = 'pr'
JOIN pull_requests pr ON pr.id = e2.from_id
WHERE e1.from_type = 'issue' 
  AND e1.from_id = 'expressjs/express#2841'
  AND e1.edge_type = 'TOUCHES'
  AND pr.id != 'expressjs/express#2841'
GROUP BY pr.id
ORDER BY shared_files DESC
LIMIT 5;

-- Step 3: Get rejected alternatives from those PRs
SELECT ra.*, e.from_id as pr_id
FROM edges e
JOIN rejected_alternatives ra ON ra.id = e.to_id
WHERE e.from_id IN (/* pr ids from steps 1 & 2 */)
  AND e.edge_type = 'REJECTS';
```

### Pattern 3: Maintainer Behavior
"How does this maintainer react to contributions like mine?"

```sql
-- Get all PRs reviewed by key maintainers, with outcomes
SELECT pr.outcome, pr.title, c.username,
       COUNT(*) OVER (PARTITION BY pr.outcome, c.username) as outcome_count
FROM edges e1
JOIN pull_requests pr ON pr.id = e1.from_id
JOIN edges e2 ON e2.from_id = pr.id AND e2.edge_type = 'REVIEWED_BY'
JOIN contributors c ON c.id = e2.to_id
WHERE e1.edge_type = 'TOUCHES'
  AND e1.to_id IN (/* files relevant to my change */)
  AND pr.state != 'open'
ORDER BY pr.merged_at DESC NULLS LAST
LIMIT 50;
```

---

## Graph population: how the graph gets built

Graph population is **on-demand and incremental**. When a tool is called for a repo that isn't cached, git-wiki fetches the minimum data needed to answer the query, populates the graph, and caches it. Background fetching expands coverage after the first hit.

### Population pipeline per resource

**When `research_issue(2841, "expressjs/express")` is first called:**

```
1. FETCH (via gh CLI):
   - gh issue view 2841 --repo expressjs/express --comments --json
   - gh api /repos/expressjs/express/issues/2841/timeline (gets cross-referenced PRs)
   
2. PARSE RELATIONSHIPS:
   - Extract "fixes #XXX" patterns from PR bodies → FIXES edges
   - Extract "related to #XXX" patterns → REFERENCES edges
   - Parse timeline for cross-reference events

3. FOR EACH REFERENCED PR (parallel, max 5):
   - gh pr view {n} --repo expressjs/express --json body,state,reviews,reviewDecision,files
   - Parse PR files list → TOUCHES edges (file nodes auto-created)
   - Parse reviewers → REVIEWED_BY edges (contributor nodes auto-created)
   - Parse co-change: record which files changed together in this PR

4. LLM EXTRACTION PASS (haiku, batched):
   - Input: issue body + comments + each PR body + key review comments
   - Output: decisions[], rejected_alternatives[], constraints[]
   - Write to graph: PRODUCED edges (pr→decision), REQUIRES edges (decision→constraint)
   - Write GOVERNED_BY edges: decision→files (files touched by the PR that produced the decision)
   - Write REJECTS edges: pr→rejected_alternative

5. CONSTRAINT HEALTH CHECK:
   - For each constraint with keywords, check CONTRIBUTING.md and recent activity
   - Update constraint.status

6. BACKGROUND FETCH (async, doesn't block response):
   - Fetch last 30 PRs for this repo for maintainer profile
   - Build CO_CHANGES_WITH edges from co-commit analysis
```

**Subsequent calls to the same repo:** Skip fetch entirely, pure graph traversal. <10ms.

**CO_CHANGES_WITH edge population (runs once per repo, async):**
```
gh api /repos/{owner}/{repo}/commits?per_page=100&sha=HEAD
For each commit:
  gh api /repos/{owner}/{repo}/commits/{sha}  → files list
  For each pair of files in same commit:
    UPSERT edge CO_CHANGES_WITH, weight += 1
```
This is the most expensive operation (~200 API calls for 100 commits) but runs in background after first hit and is cached for 48 hours.

---

## The 6 MCP tools

### Tool 1: `get_file_lore(file_path, repo?)`

**Input:** file path (relative), optional repo (defaults to current git remote)
**Graph traversal:** File → GOVERNED_BY → Decision → REQUIRES → Constraints; File → CO_CHANGES_WITH → Files
**Output (~350 tokens):**
```json
{
  "file": "src/middleware/ratelimit.ts",
  "decisions": [
    {
      "what": "IP-based rate limiting, not user-based",
      "why": "Unauthenticated endpoints exist — can't require auth context",
      "source_pr": 1203,
      "constraints": [
        {"text": "Must work for unauthenticated endpoints", "status": "active"}
      ]
    }
  ],
  "rejected_patterns": [
    "X-Forwarded-For without trusted proxy validation (spoofable) — PR #1567"
  ],
  "always_change_with": [
    {"file": "tests/middleware/ratelimit.test.ts", "co_change_rate": "100%"},
    {"file": "src/config/proxy.ts", "co_change_rate": "71%"}
  ],
  "owner": {"username": "alice", "blame_pct": 73}
}
```

### Tool 2: `research_issue(issue_number, repo?)`

**Input:** issue number, optional repo
**Graph traversal:** Issue → FIXES←PR; Issue → shared files → similar PRs; PRs → REJECTS → RejectedAlternatives; Decisions → REQUIRES → Constraints (with health)
**Output (~600 tokens):**
```json
{
  "issue": {
    "number": 2841,
    "title": "Rate limiter ignores X-Forwarded-For header",
    "summary": "Users behind proxies rate-limited by proxy IP, not real IP",
    "state": "open"
  },
  "prior_attempts": [
    {
      "pr": 1567,
      "title": "Add X-Forwarded-For support",
      "outcome": "rejected",
      "why_rejected": "Security: X-Forwarded-For is spoofable without trusted proxy validation",
      "rejected_by": "alice",
      "stale_check": {
        "constraint": "No trusted proxy config available",
        "status": "possibly_stale",
        "reason": "PR #2103 added trustedProxies config 6 months ago"
      }
    }
  ],
  "relevant_files": ["src/middleware/ratelimit.ts", "src/config/proxy.ts"],
  "related_decisions": [
    {
      "what": "IP-based limiting chosen over user-based",
      "constraint": "Must support unauthenticated endpoints",
      "constraint_status": "active"
    }
  ],
  "suggested_approach": "The rejection of #1567 was based on a constraint (no trusted proxy) now resolved by #2103. Implement X-Forwarded-For validation using the ProxyConfig from src/config/proxy.ts.",
  "ping": "@alice (owns rate limiter, made key decisions here)"
}
```

### Tool 3: `get_maintainer_style(repo?)`

**Input:** optional repo
**Graph traversal:** Repo PRs → outcomes + reviewer patterns + file-specific review behavior
**Cached:** 24hr TTL — expensive to build but rarely changes
**Output (~450 tokens):**
```json
{
  "merge_patterns": {
    "rate": "68% of contributor PRs merged",
    "avg_review_rounds": 2.1,
    "time_to_first_review": "typically within 48 hours"
  },
  "what_gets_merged": [
    "Tests included and green CI",
    "Single focused concern (PRs >5 files get 'too broad' comment 71% of time)",
    "Issue discussed before implementation"
  ],
  "recurring_review_requests": [
    "Type annotations on all new functions (mentioned in 63% of reviewed PRs)",
    "Integration test not just unit (mentioned in 44% of reviewed PRs)",
    "Link to related issue in PR description (mentioned in 38%)"
  ],
  "implicit_rules": [
    "No lodash — maintainer removes it without comment in ~40% of PRs that add it",
    "Imperative commit messages ('Add X' not 'Added X') — corrected silently in 8 PRs"
  ],
  "rejection_triggers": [
    "No tests: always requests changes",
    "Public API change without prior issue: usually closes with explanation",
    "Dependency addition without justification: requests removal in 89% of cases"
  ]
}
```

### Tool 4: `find_prior_art(description, repo?)`

**Input:** natural language description of what you're trying to do
**Graph traversal:** Semantic search over decision + PR summaries → graph expansion for context
**Uses:** LanceDB embeddings over decision/PR summaries (built during graph population)
**Output (~500 tokens):**
```json
{
  "query": "add header-based rate limit bypass",
  "results": [
    {
      "pr": 1567,
      "title": "Add X-Forwarded-For support",
      "similarity": "exact match",
      "outcome": "rejected",
      "lesson": "Needs trusted proxy validation. Use ProxyConfig from src/config/proxy.ts. See PR #2103.",
      "key_review_comment": "X-Forwarded-For is trivially spoofable — needs trusted proxy list first"
    },
    {
      "pr": 2103,
      "title": "Add trusted proxy configuration",
      "similarity": "prerequisite",
      "outcome": "merged",
      "lesson": "The enabler for the above. Adds ProxyConfig that validates forwarded headers."
    }
  ]
}
```

### Tool 5: `get_contribution_guide(repo?)`

**Input:** optional repo
**Graph traversal:** Recent PRs → review patterns + CONTRIBUTING.md + CI config
**Cached:** 24hr TTL
**Output (~300 tokens):**
```json
{
  "hard_requirements": [
    "All CI checks must pass",
    "Tests required for new behavior (integration preferred over unit for middleware)",
    "CHANGELOG.md entry required"
  ],
  "strong_preferences": [
    "TypeScript strict mode — no 'any' type (rejected in 5 recent PRs)",
    "JSDoc on exported functions",
    "Named exports only (maintainer converted 3 PRs from default exports)"
  ],
  "size_preference": "PRs touching >5 files get 'please split' in 71% of cases",
  "example_good_pr": {"number": 2801, "why": "Small, focused, tests first, issue linked"},
  "example_bad_pr": {"number": 2789, "why": "No tests, touched 8 files, no issue"},
  "contributing_doc_exists": true,
  "contributing_key_sections": ["Testing requirements (section 3)", "Commit message format (section 4)"]
}
```

### Tool 6: `get_repo_overview(repo?)`

**Input:** optional repo
**Graph traversal:** Graph-level aggregations + recent activity
**Cached:** 6hr TTL
**Output (~300 tokens):**
```json
{
  "repo": "expressjs/express",
  "graph_coverage": {
    "issues_indexed": 847,
    "prs_indexed": 523,
    "decisions_extracted": 94,
    "files_tracked": 312
  },
  "active_areas": [
    {"path": "src/middleware/", "recent_prs": 12, "open_issues": 8},
    {"path": "src/router/", "recent_prs": 6, "open_issues": 3}
  ],
  "key_decisions": [
    "Express 5.x: async error handling by default (PR #3171)",
    "Path-to-regexp v8 migration (breaking) (PR #3453)"
  ],
  "knowledge_gaps": [
    "src/request.ts: 47 changes, only 2 decisions documented",
    "src/view.ts: no decision coverage, high churn"
  ],
  "bus_factor_warnings": [
    "src/router/index.ts: @alice has 81% blame, no backup reviewer"
  ]
}
```

---

## How the graph powers token efficiency

Here's the concrete token math comparing 3 approaches:

**Scenario:** Claude Code is working on issue #2841 in expressjs/express

**Approach A — Raw `gh` CLI (no git-wiki)**
```
Claude Code calls: gh issue view 2841 --comments → 4,200 tokens
Thinks: "let me find related PRs"
Claude Code calls: gh search prs "rate limit" → 2,100 tokens  
Claude Code calls: gh pr view 1567 --comments → 5,800 tokens
Claude Code calls: gh pr view 2103 --comments → 3,100 tokens
Claude Code reasons over all this → 6,000 tokens of reasoning
Total: ~21,200 tokens. Time: 90-120 seconds.
```

**Approach B — GitHub's official MCP**
```
Same sequence, slightly better formatting, same data volume
Total: ~18,000 tokens. Same problems.
```

**Approach C — git-wiki MCP**
```
Claude Code calls: git_wiki.research_issue(2841) → 600 tokens returned
That's it. Graph traversal already did the reasoning.
Total: ~600 tokens. Time: <10ms (cache hit) or 15s (first call, fetches + builds graph).
```

**35× fewer tokens. The graph is pre-reasoned context.**

---

## Architecture diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                         Claude Code session                         │
│                                                                     │
│  User: "Help me fix issue #2841 in expressjs/express"              │
│                                                                     │
│  Claude Code calls: git_wiki.research_issue(2841, "expressjs/...")  │
└───────────────────────────────┬────────────────────────────────────┘
                                │ MCP (stdio)
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                       git-wiki MCP server                           │
│                                                                     │
│  1. Graph lookup: edges WHERE from_id = 'expressjs/express#2841'   │
│     └─ Cache hit → return in <10ms                                  │
│     └─ Cache miss → populate pipeline below                         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                 Graph population pipeline                     │  │
│  │                                                               │  │
│  │  gh CLI calls → raw JSON → relationship parsing → edge table  │  │
│  │                                    ↓                          │  │
│  │              haiku LLM → decisions + constraints + RA         │  │
│  │                                    ↓                          │  │
│  │         LanceDB embeddings → similarity search index          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  3. Graph traversal (SQLite, <5ms)                                  │
│  4. Constraint health check                                         │
│  5. Format response (~600 tokens)                                   │
└───────────────────────────────┬────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   SQLite graph            LanceDB vectors          gh CLI / 
  (nodes + edges)       (PR/decision summaries)   GitHub API
```

---

## Tech stack

| Layer | Tech | Why |
|---|---|---|
| Language | TypeScript, Node 20+ | MCP SDK is TS-first; gh CLI ecosystem; single language |
| MCP server | `@modelcontextprotocol/sdk` | Official Anthropic SDK |
| Graph + cache | `better-sqlite3` | Zero-dependency embedded DB; fast joins; 2-3 hop traversals are fast enough |
| Vector search | `vectordb` (LanceDB) | Embedded vector DB for `find_prior_art` similarity search |
| GitHub data | `gh` CLI via `execa` | Uses user's existing auth; most context-efficient per Anthropic docs |
| LLM extraction | `@anthropic-ai/sdk` (haiku) | Cheap, fast, accurate for simple extraction |
| CLI | `commander` | Standard, minimal |
| Build | `tsup` + `tsx` | Fast bundling, no config |

**Zero external services.** Everything runs locally. Uses the user's existing `gh` auth and `ANTHROPIC_API_KEY` (same one Claude Code uses).

---

## Repository structure

```
git-wiki/
├── src/
│   ├── graph/
│   │   ├── schema.ts           # SQLite schema DDL + migration
│   │   ├── db.ts               # Database connection, query helpers
│   │   ├── edges.ts            # Edge CRUD + traversal queries
│   │   └── nodes.ts            # Node CRUD for all entity types
│   │
│   ├── fetcher/
│   │   ├── gh.ts               # gh CLI wrapper (execSync/execa)
│   │   ├── parse.ts            # Parse gh output → structured objects
│   │   └── populate.ts         # Orchestrate fetching → graph population
│   │
│   ├── extract/
│   │   ├── llm.ts              # haiku extraction pass
│   │   ├── prompts.ts          # All extraction prompts
│   │   ├── relationships.ts    # Parse relationship signals (FIXES, REFERENCES, etc.)
│   │   └── cochange.ts         # Build CO_CHANGES_WITH edges from commit history
│   │
│   ├── intelligence/
│   │   ├── file-lore.ts        # get_file_lore logic
│   │   ├── issue.ts            # research_issue logic
│   │   ├── maintainer.ts       # get_maintainer_style logic
│   │   ├── prior-art.ts        # find_prior_art (graph + vector search)
│   │   ├── contribution.ts     # get_contribution_guide logic
│   │   └── overview.ts         # get_repo_overview logic
│   │
│   ├── vectors/
│   │   └── index.ts            # LanceDB operations for similarity search
│   │
│   ├── mcp/
│   │   └── server.ts           # MCP server, wires 6 tools
│   │
│   └── cli/
│       └── index.ts            # CLI commands
│
├── plugin/                     # Claude Code plugin files
│   ├── CLAUDE.md               # Skill definition (add to user's CLAUDE.md)
│   └── commands/
│       ├── wiki-issue.md       # /wiki-issue <number> slash command
│       └── wiki-pr-prep.md     # /wiki-pr-prep slash command
│
├── CLAUDE.md                   # git-wiki uses git-wiki (dogfooding)
├── README.md
└── package.json
```

---

## The graph schema in detail (SQL)

```sql
-- Complete schema for src/graph/schema.ts

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  body_summary TEXT,
  created_at INTEGER,
  closed_at INTEGER,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT,
  UNIQUE(repo, number)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  body_summary TEXT,
  merged_at INTEGER,
  closed_at INTEGER,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT,
  UNIQUE(repo, number)
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(repo, path)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  problem TEXT NOT NULL,
  choice TEXT NOT NULL,
  rationale TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  extracted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS constraints (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  status_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS contributors (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  UNIQUE(repo, username)
);

CREATE TABLE IF NOT EXISTS rejected_alternatives (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pr_id TEXT NOT NULL,
  option_text TEXT NOT NULL,
  rejection_reason TEXT,
  rejected_by TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_type, from_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_type, to_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo, number);
CREATE INDEX IF NOT EXISTS idx_prs_repo ON pull_requests(repo, number);
CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo, path);

-- Sync state tracking
CREATE TABLE IF NOT EXISTS sync_state (
  repo TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  last_fetched_at INTEGER,
  last_cursor TEXT,
  PRIMARY KEY (repo, resource_type)
);
```

---

## The LLM extraction prompt

One call to `claude-haiku-4-5-20251001` per issue/PR thread. Batch up to 20 threads per call.

```typescript
const EXTRACTION_PROMPT = `
Analyze this GitHub thread and extract structured data.

Thread:
{THREAD_TEXT}

Extract this JSON object. Be conservative — only extract what is EXPLICITLY stated.
Never infer or assume. If a field has no clear answer, use null.

{
  "problem_statement": "1 sentence: what problem was being solved (null if not a decision thread)",
  "choice_made": "1 sentence: what was decided or implemented (null if just discussion)",  
  "rationale": "1 sentence: why this choice was made — stated explicitly (null if not stated)",
  "outcome": "merged|rejected|abandoned|open",
  "outcome_reason": "1 sentence: why merged OR specifically why rejected (null if unclear)",
  "rejected_alternatives": [
    {
      "option": "what was proposed",
      "reason": "why rejected — must be explicitly stated",
      "by": "username if identifiable, else null"
    }
  ],
  "constraints": [
    "string: technical or product constraint explicitly stated in thread (e.g., 'must work without Redis')"
  ],
  "fixes_issues": [1234, 5678],
  "references_issues": [9012],
  "confidence": 0.0
}

confidence: 0.0-1.0 — how clearly was a decision made here?
  0.9+ = explicit decision with stated rationale
  0.7  = clear decision, rationale implied but not stated  
  0.4  = more discussion than decision
  0.1  = no clear decision

Return only valid JSON. No other text.
`;
```

---

## CLI (minimal, focused)

```bash
# Install
npm install -g git-wiki

# Start MCP server (primary use case)
git-wiki serve                    # stdio mode for Claude Code
git-wiki serve --http             # HTTP mode for other clients

# Add to Claude Code (run once):
claude mcp add git-wiki -- git-wiki serve

# Query from terminal (same intelligence as MCP)
git-wiki issue expressjs/express 2841
git-wiki file expressjs/express src/middleware/ratelimit.ts
git-wiki overview expressjs/express

# Graph management
git-wiki graph --status expressjs/express    # what's in the graph
git-wiki graph --clear expressjs/express     # clear cached graph
git-wiki graph --refresh expressjs/express   # force re-fetch + re-extract
```

---

## Claude Code Plugin


### CLAUDE.md addition

```markdown
## git-wiki: Repo history intelligence (MCP server)

git-wiki builds a relation graph of any GitHub repo's history and serves
token-efficient intelligence via MCP. Use it INSTEAD of manual gh research.

**ALWAYS call git-wiki before doing any of these manually:**

Before working on a GitHub issue:
  → git_wiki.research_issue({issue_number: 2841, repo: "owner/repo"})
  Returns: prior attempts, what failed and why, relevant files, stale constraints.
  Cost: ~600 tokens. Manual equivalent: 20,000+ tokens of gh reading.

Before modifying an unfamiliar file:
  → git_wiki.get_file_lore({file_path: "src/auth/jwt.ts"})
  Returns: decisions governing this file, rejected patterns, what always changes with it.
  Cost: ~350 tokens.

Before writing any code for a contribution:
  → git_wiki.get_maintainer_style() 
  Returns: merge patterns, recurring review requests, implicit rules.
  Call once per repo session. Cost: ~450 tokens.

Before searching history manually:
  → git_wiki.find_prior_art({description: "add X-Forwarded-For header support"})
  Returns: similar PRs, outcomes, extracted lessons.

Before creating a PR:
  → git_wiki.get_contribution_guide()
  Returns: requirements, strong preferences, size guidance.

DO NOT use gh to read issue history, browse PR lists, or research maintainer patterns.
git-wiki does this 35× more token-efficiently.

If git-wiki returns "not yet indexed", it's fetching in the background.
Call again in 15 seconds or proceed — the next call will hit the cache.
```

### `/wiki-issue` slash command

File: `.claude/commands/wiki-issue.md`
```markdown
---
description: Full research brief for a GitHub issue before starting work
---

Research GitHub issue $ARGUMENTS using git-wiki before writing any code.

1. Call git_wiki.research_issue with the issue number from $ARGUMENTS
   - If repo not specified, use the current git remote
   - Parse format: "2841" or "expressjs/express 2841" or "expressjs/express#2841"

2. Present the results clearly:
   - What the issue is asking for (1-2 sentences)
   - Prior attempts (if any) — what was tried, what failed, WHY it failed
   - Stale constraints — any past rejections now possibly resolved  
   - Relevant files to look at
   - Who to ping if stuck

3. Then call git_wiki.get_file_lore for each relevant file mentioned

4. Ask: "Ready to start? Or should I check the maintainer style first?"
```

### `/wiki-pr-prep` slash command

File: `.claude/commands/wiki-pr-prep.md`
```markdown
---
description: Pre-flight check before opening a PR
---

Run git-wiki pre-flight before creating the PR for current changes.

1. git_wiki.get_contribution_guide() → check all requirements
2. git_wiki.get_maintainer_style() → check for implicit rule violations  
3. git_wiki.get_file_lore() for each significantly modified file
   → check we haven't used any rejected patterns

Present as a ✅/❌/⚠️ checklist:
✅ Tests included
✅ CI passing  
⚠️ PR touches 6 files — maintainer prefers <5 (consider splitting)
❌ Using lodash.get — maintainer removes this in ~40% of PRs, use optional chaining instead
```

---

## Build order

### Week 1: Core graph + `get_file_lore` + `research_issue`

**Goal:** These two tools working end-to-end is enough for the demo GIF.

Day 1-2: Graph foundation
- `src/graph/schema.ts` — SQLite DDL, migrations
- `src/graph/db.ts` — connection, helpers, query builders
- `src/graph/edges.ts` — edge CRUD + the 3 traversal patterns

Day 2-3: Fetcher
- `src/fetcher/gh.ts` — wrapper around gh CLI, graceful fallback to GITHUB_TOKEN
- `src/fetcher/parse.ts` — parse raw gh JSON → structured objects + relationships
- `src/fetcher/populate.ts` — orchestrate fetch → parse → write to graph

Day 3-4: LLM extraction
- `src/extract/prompts.ts` — the extraction prompt above
- `src/extract/llm.ts` — haiku batch call, parse JSON response, write decisions/constraints/RA to graph
- `src/extract/relationships.ts` — FIXES/REFERENCES pattern parsing (regex + gh timeline)

Day 4-5: First two intelligence modules
- `src/intelligence/file-lore.ts` — 3 SQL traversal queries → format response
- `src/intelligence/issue.ts` — issue + PR traversal → format response with stale check

Day 5: CLI + MCP wiring
- `src/cli/index.ts` — `git-wiki issue` and `git-wiki file` commands
- `src/mcp/server.ts` — wire `get_file_lore` and `research_issue` tools

**Week 1 checkpoint:** 
```bash
git-wiki issue expressjs/express 2841
# → structured intelligence in ~15 seconds first call, <1 second subsequent
```

### Week 2: Remaining 4 tools + vector search

- `src/extract/cochange.ts` — CO_CHANGES_WITH edge builder (background async)
- `src/vectors/index.ts` — LanceDB setup for `find_prior_art`
- `src/intelligence/maintainer.ts` — pattern aggregation from review history
- `src/intelligence/prior-art.ts` — vector similarity + graph expansion
- `src/intelligence/contribution.ts` — CONTRIBUTING.md + review pattern synthesis
- `src/intelligence/overview.ts` — graph-level aggregation

**Week 2 checkpoint:** All 6 MCP tools working.

### Week 3: Plugin + launch

- `plugin/CLAUDE.md` — the CLAUDE.md skill text
- `plugin/commands/wiki-issue.md` + `wiki-pr-prep.md`
- README with demo GIF
- Submit to Claude Code plugin marketplace
- Submit to pulsemcp.com, mcpmarket.com, fastmcp.me

---

## The demo GIF (build toward this)

```bash
# Terminal 1: git-wiki serve running
$ git-wiki serve
git-wiki MCP server ready. Add to Claude Code: claude mcp add git-wiki -- git-wiki serve

# Terminal 2: Claude Code with git-wiki connected
$ claude
> /wiki-issue expressjs/express 2841

[git-wiki fetching...] (15 seconds first time, shows spinner)

Issue #2841 — Rate limiter ignores X-Forwarded-For header

Prior art (2 related PRs found):
  PR #1567 [REJECTED 2023]: Tried exactly this.
  → Why rejected: "X-Forwarded-For is spoofable — needs trusted proxy list first" (@alice)
  → ⚠️  STALE: PR #2103 added trustedProxies config 6 months ago. Rejection may no longer apply.

  PR #2103 [MERGED 2024]: Added trusted proxy configuration.
  → This resolves the blocker from #1567. Use src/config/proxy.ts ProxyConfig.

Files to touch: src/middleware/ratelimit.ts, src/config/proxy.ts
Always update together with: tests/middleware/ratelimit.test.ts (100% co-change rate)

Suggested approach: Implement X-Forwarded-For using ProxyConfig from #2103.
The previous rejection reason is now resolved. Ping @alice for review (73% ownership).

Ready to start implementing?
```

**That output: 580 tokens. Manual equivalent: 22,000+ tokens. 38× better.**

---

## Why SQLite graph beats a real graph DB for this use case

**Our graph properties:**
- Max ~50,000 nodes per large repo (issues + PRs + files + decisions + contributors)
- Traversal depth: 2-3 hops maximum
- Query patterns: fully predictable (not ad-hoc Cypher)
- Deployment: local-first, single user, embedded

**What Neo4j/graph DBs give you that we don't need:**
- Arbitrary path finding at 10+ hops
- Concurrent writes from multiple processes
- Hundreds of millions of nodes
- OLAP-style graph analytics

**What SQLite gives us:**
- Zero setup, zero dependencies
- Indexed joins for our specific traversal patterns are <5ms
- Single file, trivially portable
- `better-sqlite3` is synchronous — no async complexity
- Every developer already understands SQL

SQLite with the edge schema above handles our traversals faster than Neo4j would due to lower overhead. The right tool for the scale.

---

## The name: git-wiki

"Wiki" — a wiki is accumulated knowledge that grows over time, collaboratively built, always accessible. That's exactly what this builds: the institutional wiki of your GitHub repo's decision history, automatically extracted and always queryable.

`npm install -g git-wiki` — clean, memorable, describes it exactly.

---

## OSS model

MIT license. Free forever for local use. The cloud-hosted version (index any public repo without running locally, shareable team access) is the monetization path.

git-wiki dogfoods itself from day one — the git-wiki repo has git-wiki installed and all its own architectural decisions are indexed.


---

