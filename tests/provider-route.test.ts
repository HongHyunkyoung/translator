// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/realtime/provider/route";

const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
const originalRealtimeProvider = process.env.REALTIME_PROVIDER;

afterEach(() => {
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }

  if (originalGeminiApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalGeminiApiKey;
  }

  if (originalGoogleApiKey === undefined) {
    delete process.env.GOOGLE_API_KEY;
  } else {
    process.env.GOOGLE_API_KEY = originalGoogleApiKey;
  }

  if (originalRealtimeProvider === undefined) {
    delete process.env.REALTIME_PROVIDER;
  } else {
    process.env.REALTIME_PROVIDER = originalRealtimeProvider;
  }
});

describe("GET /api/realtime/provider", () => {
  it("returns gemini when only a Gemini key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-key";

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "gemini",
      availableProviders: ["gemini"],
    });
  });

  it("returns openai when only an OpenAI key is configured", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "openai",
      availableProviders: ["openai"],
    });
  });

  it("honors REALTIME_PROVIDER when both providers are available", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.REALTIME_PROVIDER = "gemini";

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "gemini",
      availableProviders: ["openai", "gemini"],
    });
  });
});
