// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock("@google/genai", () => {
  class GoogleGenAI {
    models = {
      generateContent: generateContentMock,
    };
  }

  return { GoogleGenAI };
});

import { POST } from "@/app/api/realtime/translate/route";

const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
const originalGeminiTranslationModel = process.env.GEMINI_TRANSLATION_MODEL;

afterEach(() => {
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

  if (originalGeminiTranslationModel === undefined) {
    delete process.env.GEMINI_TRANSLATION_MODEL;
  } else {
    process.env.GEMINI_TRANSLATION_MODEL = originalGeminiTranslationModel;
  }

  generateContentMock.mockReset();
});

function buildRequest(body: unknown) {
  return new Request("http://localhost/api/realtime/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/realtime/translate", () => {
  it("returns 500 when the Gemini key is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const response = await POST(
      buildRequest({
        provider: "gemini",
        transcript: "Hello",
        settings: {
          provider: "gemini",
          targetLanguage: "ko",
          sourceLanguageMode: "auto",
        },
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "GEMINI_API_KEY or GOOGLE_API_KEY is missing on the server.",
    });
  });

  it("rejects non-Gemini provider requests", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";

    const response = await POST(
      buildRequest({
        provider: "openai",
        transcript: "Hello",
        settings: {
          provider: "openai",
          targetLanguage: "ko",
          sourceLanguageMode: "auto",
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "The translation route currently supports only the Gemini provider.",
    });
  });

  it("returns translated text from Gemini", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GEMINI_TRANSLATION_MODEL = "gemini-translation-custom";
    generateContentMock.mockResolvedValue({ text: "Annyeonghaseyo" });

    const response = await POST(
      buildRequest({
        provider: "gemini",
        transcript: "Hello",
        settings: {
          provider: "gemini",
          targetLanguage: "ko",
          sourceLanguageMode: "manual",
          sourceLanguage: "en",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "Annyeonghaseyo",
      model: "gemini-translation-custom",
    });

    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-translation-custom",
      contents: "Hello",
      config: expect.objectContaining({
        temperature: 0.2,
      }),
    });
  });
});
