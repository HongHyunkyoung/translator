// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/realtime/session/route";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalRealtimeModel = process.env.OPENAI_REALTIME_MODEL;
const originalTranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL;

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
  it("returns 500 when the server API key is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = await POST(
      buildRequest({
        targetLanguage: "en",
        sourceLanguageMode: "auto",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "OPENAI_API_KEY is missing on the server.",
    });
  });

  it("rejects unsupported languages before calling OpenAI", async () => {
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

  it("returns an ephemeral key and the resolved session config", async () => {
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
});
