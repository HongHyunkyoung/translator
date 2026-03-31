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
const originalOpenAIApiKey = process.env.OPENAI_API_KEY;
const originalOpenAITranslationModel = process.env.OPENAI_TRANSLATION_MODEL;

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

  if (originalOpenAIApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIApiKey;
  }

  if (originalOpenAITranslationModel === undefined) {
    delete process.env.OPENAI_TRANSLATION_MODEL;
  } else {
    process.env.OPENAI_TRANSLATION_MODEL = originalOpenAITranslationModel;
  }

  generateContentMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("returns 500 when the OpenAI key is missing", async () => {
    delete process.env.OPENAI_API_KEY;

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

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "OPENAI_API_KEY is missing on the server.",
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
      contents: expect.stringContaining('Translate the quoted source utterance into the requested target language.'),
      config: expect.objectContaining({
        temperature: 0,
      }),
    });
    expect(String(generateContentMock.mock.calls[0]?.[0]?.contents)).toContain('"""Hello"""');
  });

  it("returns translated text from OpenAI", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.OPENAI_TRANSLATION_MODEL = "gpt-4o-mini-custom";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  text: "\uC548\uB155\uD558\uC138\uC694",
                  type: "output_text",
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      buildRequest({
        provider: "openai",
        transcript: "Hello",
        settings: {
          provider: "openai",
          targetLanguage: "ko",
          sourceLanguageMode: "manual",
          sourceLanguage: "en",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      text: "\uC548\uB155\uD558\uC138\uC694",
      model: "gpt-4o-mini-custom",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openai-key",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
      expect.objectContaining({
        model: "gpt-4o-mini-custom",
        input: expect.stringContaining('"""Hello"""'),
      }),
    );
  });
});