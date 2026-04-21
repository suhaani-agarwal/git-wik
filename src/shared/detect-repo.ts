import { execa } from "execa";

/**
 * Detect the GitHub repo (owner/name) from the git remote in the current
 * working directory. Returns null if not in a git repo or remote isn't GitHub.
 */
export async function detectRepoFromCwd(): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"]);
    const url = stdout.trim();
    // https://github.com/owner/repo.git  or  https://github.com/owner/repo
    const httpsMatch = /github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(url);
    if (httpsMatch) return httpsMatch[1]!;
    // git@github.com:owner/repo.git
    const sshMatch = /github\.com:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(url);
    if (sshMatch) return sshMatch[1]!;
    return null;
  } catch {
    return null;
  }
}
