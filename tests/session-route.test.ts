// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const { authTokenCreateMock } = vi.hoisted(() => ({
  authTokenCreateMock: vi.fn(),
}));

vi.mock("@google/genai", () => {
  class GoogleGenAI {
    authTokens = {
      create: authTokenCreateMock,
    };
  }

  return {
    GoogleGenAI,
    Modality: {
      AUDIO: "AUDIO",
    },
  };
});

import { POST } from "@/app/api/realtime/session/route";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalRealtimeModel = process.env.OPENAI_REALTIME_MODEL;
const originalTranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
const originalGeminiLiveModel = process.env.GEMINI_LIVE_MODEL;
const originalGeminiTranslationModel = process.env.GEMINI_TRANSLATION_MODEL;
const originalRealtimeProvider = process.env.REALTIME_PROVIDER;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }

  if (originalRealtimeModel === undefined) {
    delete process.env.OPENAI_REALTIME_MODEL;
  } else {
    process.env.OPENAI_REALTIME_MODEL = originalRealtimeModel;
  }

  if (originalTranscriptionModel === undefined) {
    delete process.env.OPENAI_TRANSCRIPTION_MODEL;
  } else {
    process.env.OPENAI_TRANSCRIPTION_MODEL = originalTranscriptionModel;
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

  if (originalGeminiLiveModel === undefined) {
    delete process.env.GEMINI_LIVE_MODEL;
  } else {
    process.env.GEMINI_LIVE_MODEL = originalGeminiLiveModel;
  }

  if (originalGeminiTranslationModel === undefined) {
    delete process.env.GEMINI_TRANSLATION_MODEL;
  } else {
    process.env.GEMINI_TRANSLATION_MODEL = originalGeminiTranslationModel;
  }

  if (originalRealtimeProvider === undefined) {
    delete process.env.REALTIME_PROVIDER;
  } else {
    process.env.REALTIME_PROVIDER = originalRealtimeProvider;
  }

  authTokenCreateMock.mockReset();
});

function buildRequest(body: unknown) {
  return new Request("http://localhost/api/realtime/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/realtime/session", () => {
  it("returns 500 when no supported provider key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const response = await POST(
      buildRequest({
        targetLanguage: "en",
        sourceLanguageMode: "auto",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "No supported realtime API key is configured on the server. Set OPENAI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
    });
  });

  it("rejects unsupported languages before calling providers", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      buildRequest({
        targetLanguage: "xx",
        sourceLanguageMode: "manual",
        sourceLanguage: "ko",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "targetLanguage must be one of the supported language codes.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a normalized upstream error when OpenAI is unreachable", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      buildRequest({
        targetLanguage: "en",
        sourceLanguageMode: "auto",
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Could not reach OpenAI: socket hang up",
    });
  });

  it("returns an ephemeral key and the resolved OpenAI session config", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-mini";
    process.env.OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          client_secret: {
            value: "ephemeral-123",
          },
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
        targetLanguage: "en",
        sourceLanguageMode: "manual",
        sourceLanguage: "ko",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "openai",
      ephemeralKey: "ephemeral-123",
      model: "gpt-realtime-mini",
      transcriptionModel: "gpt-4o-mini-transcribe",
      sessionConfig: {
        model: "gpt-realtime-mini",
        audio: {
          input: {
            transcription: {
              language: "ko",
            },
          },
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("returns 500 when Gemini is requested but no provider key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const response = await POST(
      buildRequest({
        provider: "gemini",
        targetLanguage: "en",
        sourceLanguageMode: "auto",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "No supported realtime API key is configured on the server. Set OPENAI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
    });
  });

  it("returns a Gemini Live token and setup config", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GEMINI_LIVE_MODEL = "gemini-live-custom";
    process.env.GEMINI_TRANSLATION_MODEL = "gemini-translation-custom";
    authTokenCreateMock.mockResolvedValue({ name: "gemini-token-123" });

    const response = await POST(
      buildRequest({
        provider: "gemini",
        targetLanguage: "ja",
        sourceLanguageMode: "manual",
        sourceLanguage: "ko",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      provider: "gemini",
      ephemeralKey: "gemini-token-123",
      model: "gemini-live-custom",
      translationModel: "gemini-translation-custom",
      sessionConfig: {
        model: "models/gemini-live-custom",
        generationConfig: {
          responseModalities: ["AUDIO"],
          maxOutputTokens: 1,
          temperature: 0,
        },
        inputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            prefixPaddingMs: 300,
            silenceDurationMs: 550,
          },
        },
        systemInstruction: {
          parts: [
            {
              text:
                "Use inputAudioTranscription to transcribe live speech. Do not answer, do not translate, and do not produce spoken replies for audio-only turns. Stay silent unless the client explicitly sends a text request.",
            },
          ],
        },
      },
    });

    expect(authTokenCreateMock).toHaveBeenCalledWith({
      config: expect.objectContaining({
        uses: 1,
        liveConnectConstraints: {
          model: "gemini-live-custom",
          config: {
            responseModalities: ["AUDIO"],
            maxOutputTokens: 1,
            temperature: 0,
            inputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                prefixPaddingMs: 300,
                silenceDurationMs: 550,
              },
            },
            systemInstruction: {
              parts: [
                {
                  text:
                    "Use inputAudioTranscription to transcribe live speech. Do not answer, do not translate, and do not produce spoken replies for audio-only turns. Stay silent unless the client explicitly sends a text request.",
                },
              ],
            },
          },
        },
        httpOptions: {
          apiVersion: "v1alpha",
        },
      }),
    });
  });
});
