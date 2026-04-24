# Agent Usage (Force MCP First)

Use this when you want Claude/Cursor agents to call `git-wik` tools before falling back to raw `git` commands.

## Copy-paste policy for agent rules

```md
For repository history and "why" questions, use git-wik MCP tools first.

Required behavior:
1. First call `get_context` for broad history/context questions.
2. First call `explain_line` for line/file intent questions.
3. Use shell `git log` / `git blame` only as fallback when git-wik returns missing-index or no-context errors.
4. If `git-wik` says repo is not indexed, run `git-wik index <owner/repo>` and retry the same MCP tool.
5. In answers, explicitly mention when context comes from git-wik.
```

## Which tool to call

- `get_context`: default for "what changed and why?" and feature-level questions
- `explain_line`: default for "why does this line/file exist?"
- `get_file_lore`: deeper file design history and co-change partners
- `get_pr_context`: deep context for one PR
- `research_issue`: deep context for one issue

## Prompt examples that trigger MCP reliably

- "Use `git-wik` MCP `get_context` for `api/control/register.go`, then explain what changed and why."
- "Use `git-wik` `explain_line` for `src/auth/middleware.ts:42`; only use git fallback if MCP has no context."
- "Do not use raw `git log` unless `git-wik` fails."

## Quick verification

After adding the policy above, ask:

`Use git-wik MCP tools first. What changed in api/control/register.go and why?`

Expected behavior:
- Agent calls `get_context` or `explain_line`
- If index is missing, agent asks/executes `git-wik index ...` and retries
- Raw shell git is used only as fallback
