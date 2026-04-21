/**
 * Typed error classes with user-friendly messages for the git-wik CLI.
 * All errors write to stderr; stdout is reserved for machine-readable output.
 */

export class GhCliNotFoundError extends Error {
  constructor() {
    super("gh CLI not found. Install from https://cli.github.com");
    this.name = "GhCliNotFoundError";
  }
}

export class GhAuthError extends Error {
  constructor(repo?: string) {
    const detail = repo ? ` for ${repo}` : "";
    super(`Not authenticated${detail}. Run: gh auth login`);
    this.name = "GhAuthError";
  }
}

export class GhRateLimitError extends Error {
  readonly resetAt: Date | null;

  constructor(resetAt?: Date) {
    const hint = resetAt
      ? ` Retry after ${resetAt.toLocaleTimeString()}.`
      : "";
    super(
      `GitHub API rate limit exceeded.${hint} Use --since to index incrementally.`
    );
    this.name = "GhRateLimitError";
    this.resetAt = resetAt ?? null;
  }
}

export class PrivateRepoError extends Error {
  constructor(repo: string) {
    super(
      `Could not access ${repo}. Check: gh auth status\n` +
      `For private repos without gh auth, configure a GitHub App: git-wik app-server --help`
    );
    this.name = "PrivateRepoError";
  }
}

export class LLMSdkNotInstalledError extends Error {
  constructor(provider: "anthropic" | "gemini") {
    const pkg = provider === "anthropic" ? "@anthropic-ai/sdk" : "@google/genai";
    super(
      `${pkg} is not installed. Run: npm install -g ${pkg}\n` +
      `Or skip enrichment with: --provider none`
    );
    this.name = "LLMSdkNotInstalledError";
  }
}

/**
 * Format any error for stderr display.
 * Known errors get clean messages; unknown errors get full stack in dev mode.
 */
export function formatError(err: unknown): string {
  if (
    err instanceof GhCliNotFoundError ||
    err instanceof GhAuthError ||
    err instanceof GhRateLimitError ||
    err instanceof PrivateRepoError ||
    err instanceof LLMSdkNotInstalledError
  ) {
    return `Error: ${err.message}`;
  }
  if (err instanceof Error) {
    return process.env["DEBUG"]
      ? `Error: ${err.message}\n${err.stack ?? ""}`
      : `Error: ${err.message}`;
  }
  return `Error: ${String(err)}`;
}
