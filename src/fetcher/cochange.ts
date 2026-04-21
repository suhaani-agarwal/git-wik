import { execa } from "execa";
import { getDb, isStale, markFetched, upsertFile, upsertEdge } from "../graph/db.js";
import { fetchRecentCommits, fetchCommitFiles } from "./gh.js";
import { extractCoChangePairs, parseGitLogOutput } from "./parse.js";

const CO_CHANGE_TTL = 6 * 60 * 60; // 6 hours

/**
 * Build CO_CHANGES_WITH edges from a local git clone.
 *
 * This is the preferred method: one subprocess call processes thousands of
 * commits with zero network usage, vs. one API call per commit via GitHub.
 *
 * @param repo        "owner/name" — used for DB node IDs
 * @param localPath   Absolute path to the local git working tree
 * @param limit       Max commits to analyse (default: 500)
 */
export async function populateCoChangeFromGit(
  repo: string,
  localPath: string,
  limit = 500
): Promise<number> {
  const db = getDb(repo);
  if (!isStale(db, repo, "repo:cochange:git", CO_CHANGE_TTL)) return 0;

  let stdout: string;
  try {
    const result = await execa(
      "git",
      [
        "log",
        "--name-only",
        `--pretty=format:%H`,
        `-n`, String(limit),
        "--diff-filter=ACDMR",  // Added, Copied, Deleted, Modified, Renamed
      ],
      { cwd: localPath }
    );
    stdout = result.stdout;
  } catch {
    return 0;
  }

  const commits = parseGitLogOutput(stdout);
  const commitFilesList = commits.map((c) => c.files);
  const pairs = extractCoChangePairs(commitFilesList);

  const now = Math.floor(Date.now() / 1000);
  for (const { fileA, fileB } of pairs) {
    const idA = `${repo}::${fileA}`;
    const idB = `${repo}::${fileB}`;
    upsertFile(db, { id: idA, repo, path: fileA, last_seen_at: now });
    upsertFile(db, { id: idB, repo, path: fileB, last_seen_at: now });
    upsertEdge(db, {
      from_type: "file", from_id: idA,
      edge_type: "CO_CHANGES_WITH",
      to_type: "file", to_id: idB,
      weight: 1, metadata_json: null,
    });
  }

  markFetched(db, repo, "repo:cochange:git");
  return pairs.length;
}

/**
 * Build CO_CHANGES_WITH edges via the GitHub API.
 *
 * Fallback for when no local clone is available. Capped at 30 commits to
 * avoid consuming a large portion of the GitHub API rate limit (5000 req/hr).
 * Each commit requires one additional API call to fetch its file list.
 *
 * @param repo   "owner/name"
 * @param limit  Max commits to fetch (default: 30, hard max: 50)
 */
export async function populateCoChangeFromGitHub(
  repo: string,
  limit = 30
): Promise<number> {
  const db = getDb(repo);
  if (!isStale(db, repo, "repo:cochange:gh", CO_CHANGE_TTL)) return 0;

  const safeLimit = Math.min(limit, 50);
  const commits = await fetchRecentCommits(repo, safeLimit);

  // Fetch file lists for each commit in parallel (capped to avoid rate limits)
  const commitFilesList = await Promise.all(
    commits.map((c) => fetchCommitFiles(repo, c.sha))
  );

  const pairs = extractCoChangePairs(commitFilesList);
  const now = Math.floor(Date.now() / 1000);

  for (const { fileA, fileB } of pairs) {
    const idA = `${repo}::${fileA}`;
    const idB = `${repo}::${fileB}`;
    upsertFile(db, { id: idA, repo, path: fileA, last_seen_at: now });
    upsertFile(db, { id: idB, repo, path: fileB, last_seen_at: now });
    upsertEdge(db, {
      from_type: "file", from_id: idA,
      edge_type: "CO_CHANGES_WITH",
      to_type: "file", to_id: idB,
      weight: 1, metadata_json: null,
    });
  }

  markFetched(db, repo, "repo:cochange:gh");
  return pairs.length;
}
