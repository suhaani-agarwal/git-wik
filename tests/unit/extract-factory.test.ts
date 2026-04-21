import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProvider } from "../../src/extract/factory.js";

describe("createProvider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

  it("returns null when no keys are set (auto)", () => {
    expect(createProvider("auto")).toBeNull();
  });

  it("returns null when no keys are set (default)", () => {
    expect(createProvider()).toBeNull();
  });

  it("prefers Anthropic over Gemini in auto mode", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    process.env["GEMINI_API_KEY"] = "gm-test";
    const provider = createProvider("auto");
    expect(provider?.name).toBe("anthropic");
  });

  it("falls back to Gemini when only GEMINI_API_KEY is set", () => {
    process.env["GEMINI_API_KEY"] = "gm-test";
    const provider = createProvider("auto");
    expect(provider?.name).toBe("gemini");
  });

  it("falls back to Gemini with GOOGLE_API_KEY", () => {
    process.env["GOOGLE_API_KEY"] = "gk-test";
    const provider = createProvider("auto");
    expect(provider?.name).toBe("gemini");
  });

  it("returns anthropic provider when requested explicitly", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    const provider = createProvider("anthropic");
    expect(provider?.name).toBe("anthropic");
  });

  it("returns null when anthropic is requested but key is missing", () => {
    expect(createProvider("anthropic")).toBeNull();
  });

  it("returns gemini provider when requested explicitly", () => {
    process.env["GEMINI_API_KEY"] = "gm-test";
    const provider = createProvider("gemini");
    expect(provider?.name).toBe("gemini");
  });

  it("returns null when gemini is requested but key is missing", () => {
    expect(createProvider("gemini")).toBeNull();
  });
});
