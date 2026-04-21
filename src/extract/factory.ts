import type { LLMProvider, ProviderName } from "./types.js";

/**
 * Create an LLM provider based on the requested preference and available API keys.
 *
 * - "anthropic" — uses ANTHROPIC_API_KEY; returns null if not set
 * - "gemini"    — uses GEMINI_API_KEY or GOOGLE_API_KEY; returns null if not set
 * - "auto"      — prefers Anthropic (prompt caching = cheaper for bulk enrichment),
 *                 falls back to Gemini, returns null if neither key is present
 *
 * Both provider classes use dynamic import so their SDKs are never loaded when
 * enrichment is not needed (e.g., MCP server serving cached data).
 */
export function createProvider(preference: ProviderName = "auto"): LLMProvider | null {
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const geminiKey    = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];

  if (preference === "anthropic") {
    if (!anthropicKey) return null;
    // Lazy-load to avoid circular dep issues at module load time
    return new LazyAnthropicProvider(anthropicKey);
  }

  if (preference === "gemini") {
    if (!geminiKey) return null;
    return new LazyGeminiProvider(geminiKey);
  }

  // auto: prefer Anthropic (prompt caching makes bulk enrichment cheaper)
  if (anthropicKey) return new LazyAnthropicProvider(anthropicKey);
  if (geminiKey)    return new LazyGeminiProvider(geminiKey);
  return null;
}

// ── Lazy wrapper classes ───────────────────────────────────────────────────────
// Instantiate the real provider class on first use to avoid loading unused SDKs.

import type { ExtractionResult } from "./types.js";
import { EMPTY_RESULT } from "./types.js";

class LazyAnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  private inner: LLMProvider | null = null;

  constructor(private readonly apiKey: string) {}

  async extractThread(threadText: string): Promise<ExtractionResult> {
    if (!this.inner) {
      const { AnthropicProvider } = await import("./providers/anthropic.js");
      this.inner = new AnthropicProvider(this.apiKey);
    }
    return this.inner.extractThread(threadText);
  }
}

class LazyGeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  private inner: LLMProvider | null = null;

  constructor(private readonly apiKey: string) {}

  async extractThread(threadText: string): Promise<ExtractionResult> {
    if (!this.inner) {
      const { GeminiProvider } = await import("./providers/gemini.js");
      this.inner = new GeminiProvider(this.apiKey);
    }
    return this.inner.extractThread(threadText);
  }
}
