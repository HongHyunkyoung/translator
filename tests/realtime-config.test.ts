import { afterEach, describe, expect, it } from "vitest";
import {
  buildClientSecretRequest,
  buildGeminiLiveSessionConfig,
  buildRealtimeSessionConfig,
  buildTranslatorInstructions,
  buildTranscriptionPrompt,
  getGeminiLiveModel,
  getGeminiTranslationModel,
} from "@/lib/realtime-config";

const originalRealtimeModel = process.env.OPENAI_REALTIME_MODEL;
const originalTranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL;
const originalGeminiLiveModel = process.env.GEMINI_LIVE_MODEL;
const originalGeminiTranslationModel = process.env.GEMINI_TRANSLATION_MODEL;

afterEach(() => {
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
});

describe("realtime-config", () => {
  it("builds manual-language instructions and the OpenAI session config", () => {
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-mini";
    process.env.OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

    const settings = {
      provider: "openai" as const,
      targetLanguage: "en",
      sourceLanguageMode: "manual" as const,
      sourceLanguage: "ko",
    };

    expect(buildTranslatorInstructions(settings)).toContain("Translate every completed user utterance into English.");
    expect(buildTranslatorInstructions(settings)).toContain("The speaker will use Korean.");
    expect(buildTranslatorInstructions(settings)).toContain("Make the translation sound natural, conversational, and native");
    expect(buildTranscriptionPrompt(settings)).toContain("The spoken language will be Korean.");

    expect(buildRealtimeSessionConfig(settings)).toEqual({
      type: "realtime",
      model: "gpt-realtime-mini",
      instructions: buildTranslatorInstructions(settings),
      output_modalities: ["text"],
      audio: {
        input: {
          noise_reduction: {
            type: "near_field",
          },
          transcription: {
            model: "gpt-4o-mini-transcribe",
            prompt: buildTranscriptionPrompt(settings),
            language: "ko",
          },
          turn_detection: {
            type: "server_vad",
            create_response: false,
            interrupt_response: false,
            prefix_padding_ms: 300,
            silence_duration_ms: 320,
          },
        },
      },
    });
  });

  it("omits manual source details when auto-detect is enabled", () => {
    const settings = {
      provider: "openai" as const,
      targetLanguage: "ja",
      sourceLanguageMode: "auto" as const,
      sourceLanguage: "ko",
    };

    const prompt = buildTranscriptionPrompt(settings);
    const instructions = buildTranslatorInstructions(settings);
    const request = buildClientSecretRequest(settings);

    expect(prompt).not.toContain("spoken language will be");
    expect(instructions).toContain("Translate every completed user utterance into Japanese.");
    expect(instructions).toContain("Prefer everyday phrasing and idiomatic wording");
    expect(instructions).toContain("Detect the speaker's source language automatically for each turn.");
    expect(request.expires_after.seconds).toBe(600);
    expect(request.session.audio.input.transcription).not.toHaveProperty("language");
  });

  it("builds the Gemini Live setup and resolves Gemini model defaults", () => {
    process.env.GEMINI_LIVE_MODEL = "gemini-live-custom";
    process.env.GEMINI_TRANSLATION_MODEL = "gemini-translation-custom";

    expect(getGeminiLiveModel()).toBe("gemini-live-custom");
    expect(getGeminiTranslationModel()).toBe("gemini-translation-custom");
    expect(buildGeminiLiveSessionConfig()).toEqual({
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
          silenceDurationMs: 320,
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
    });
  });
});

