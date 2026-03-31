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

import { POST } from "@/app/api/realtime/speak/route";

const originalOpenAIApiKey = process.env.OPENAI_API_KEY;
const originalOpenAITtsModel = process.env.OPENAI_TTS_MODEL;
const originalOpenAITtsVoice = process.env.OPENAI_TTS_VOICE;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;
const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
const originalGeminiTtsModel = process.env.GEMINI_TTS_MODEL;
const originalGeminiTtsVoice = process.env.GEMINI_TTS_VOICE;
const originalGeminiTtsVoiceKo = process.env.GEMINI_TTS_VOICE_KO;
const originalRealtimeProvider = process.env.REALTIME_PROVIDER;

afterEach(() => {
  if (originalOpenAIApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIApiKey;
  }

  if (originalOpenAITtsModel === undefined) {
    delete process.env.OPENAI_TTS_MODEL;
  } else {
    process.env.OPENAI_TTS_MODEL = originalOpenAITtsModel;
  }

  if (originalOpenAITtsVoice === undefined) {
    delete process.env.OPENAI_TTS_VOICE;
  } else {
    process.env.OPENAI_TTS_VOICE = originalOpenAITtsVoice;
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

  if (originalGeminiTtsModel === undefined) {
    delete process.env.GEMINI_TTS_MODEL;
  } else {
    process.env.GEMINI_TTS_MODEL = originalGeminiTtsModel;
  }

  if (originalGeminiTtsVoice === undefined) {
    delete process.env.GEMINI_TTS_VOICE;
  } else {
    process.env.GEMINI_TTS_VOICE = originalGeminiTtsVoice;
  }

  if (originalGeminiTtsVoiceKo === undefined) {
    delete process.env.GEMINI_TTS_VOICE_KO;
  } else {
    process.env.GEMINI_TTS_VOICE_KO = originalGeminiTtsVoiceKo;
  }

  if (originalRealtimeProvider === undefined) {
    delete process.env.REALTIME_PROVIDER;
  } else {
    process.env.REALTIME_PROVIDER = originalRealtimeProvider;
  }

  generateContentMock.mockReset();
});

function buildRequest(body: unknown) {
  return new Request("http://localhost/api/realtime/speak", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/realtime/speak", () => {
  it("returns 500 when no supported provider key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const response = await POST(
      buildRequest({
        targetLanguage: "en",
        text: "Hello",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        "No supported realtime API key is configured on the server. Set OPENAI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
    });
  });

  it("returns Gemini-generated wav audio", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
    delete process.env.GEMINI_TTS_VOICE;
    delete process.env.GEMINI_TTS_VOICE_KO;
    process.env.REALTIME_PROVIDER = "gemini";

    const pcmData = Buffer.from(Uint8Array.from([0, 0, 255, 127]));
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  data: pcmData.toString("base64"),
                },
              },
            ],
          },
        },
      ],
    });

    const response = await POST(
      buildRequest({
        targetLanguage: "ko",
        text: "¾È³çÇÏ¼¼¿ä",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    expect(audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(generateContentMock).toHaveBeenCalledWith({
      model: "gemini-2.5-flash-preview-tts",
      contents: expect.stringContaining("Read the Korean translation like natural spoken interpretation for a live listener."),
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: "ko-KR",
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Despina",
            },
          },
        },
      },
    });
  });

  it("passes through OpenAI wav audio", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
    process.env.OPENAI_TTS_VOICE = "marin";
    process.env.REALTIME_PROVIDER = "openai";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from("wav-audio"), {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      buildRequest({
        targetLanguage: "en",
        text: "Hello there",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe("wav-audio");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer openai-key",
        }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "marin",
      input: "Hello there",
      response_format: "wav",
      speed: 0.96,
    });
  });
});

