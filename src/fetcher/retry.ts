import { execa, type ExecaError } from "execa";
import { GhCliNotFoundError, GhAuthError, GhRateLimitError, PrivateRepoError } from "../cli/errors.js";

export interface GhCallOptions {
  /** Max attempts before giving up (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs?: number;
}

/**
 * Classify a gh CLI error into a typed error or re-throw unknown errors.
 * Parses exit codes and stderr text from the gh CLI.
 */
function classifyGhError(err: unknown, args: string[]): never {
  const e = err as ExecaError;
  const stderr = (e.stderr as string | undefined) ?? "";
  const message = stderr.toLowerCase();

  if (e.code === "ENOENT" || message.includes("not found")) {
    throw new GhCliNotFoundError();
  }
  if (
    message.includes("authentication") ||
    message.includes("not logged in") ||
    message.includes("unauthorized") ||
    message.includes("401")
  ) {
    throw new GhAuthError();
  }
  if (
    message.includes("rate limit") ||
    message.includes("403") ||
    message.includes("429")
  ) {
    // Try to extract reset time from stderr (gh prints it)
    const resetMatch = stderr.match(/reset[:\s]+(.+)/i);
    const resetAt = resetMatch ? new Date(resetMatch[1]!) : undefined;
    throw new GhRateLimitError(resetAt);
  }
  if (
    message.includes("not found") ||
    message.includes("404") ||
    (message.includes("could not resolve") && args.some((a) => a.includes("/")))
  ) {
    // Best-effort: detect private repo access denial
    const repoArg = args.find((a) => a.includes("/")) ?? "unknown/repo";
    throw new PrivateRepoError(repoArg);
  }

  throw err;
}

/**
 * Run a gh CLI command with typed error classification and exponential backoff
 * for transient failures (network errors, 5xx responses).
 *
 * Throws typed errors (GhAuthError, GhRateLimitError, etc.) rather than raw
 * ExecaError so callers can handle specific cases cleanly.
 */
export async function ghJson<T>(
  args: string[],
  opts: GhCallOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay   = opts.baseDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout } = await execa("gh", args);
      return JSON.parse(stdout) as T;
    } catch (err) {
      const e = err as ExecaError;
      const stderr = (e.stderr as string | undefined) ?? "";

      // Non-retryable: auth, rate limit, not found → classify immediately
      if (
        stderr.includes("authentication") ||
        stderr.includes("unauthorized") ||
        stderr.includes("rate limit") ||
        stderr.includes("not found") ||
        stderr.includes("404") ||
        (e.code as string | undefined) === "ENOENT"
      ) {
        classifyGhError(err, args);
      }

      // Retryable: network error, 5xx, timeout
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }

      // Final attempt failed — classify or re-throw
      classifyGhError(err, args);
    }
  }

  // Should be unreachable
  throw new Error("ghJson: exhausted retries");
}

/**
 * Run a gh api endpoint with retry logic.
 */
export async function ghApi<T>(
  endpoint: string,
  opts: GhCallOptions = {}
): Promise<T> {
  return ghJson<T>(["api", endpoint], opts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
