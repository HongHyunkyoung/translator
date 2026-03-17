import { afterEach, describe, expect, it } from "vitest";
import {
  buildClientSecretRequest,
  buildRealtimeSessionConfig,
  buildTranslatorInstructions,
  buildTranscriptionPrompt,
} from "@/lib/realtime-config";

const originalRealtimeModel = process.env.OPENAI_REALTIME_MODEL;
const originalTranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL;

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
});

describe("realtime-config", () => {
  it("builds manual-language instructions and session config", () => {
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-mini";
    process.env.OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

    const settings = {
      targetLanguage: "en",
      sourceLanguageMode: "manual" as const,
      sourceLanguage: "ko",
    };

    expect(buildTranslatorInstructions(settings)).toContain("Translate every completed user utterance into English.");
    expect(buildTranslatorInstructions(settings)).toContain("The speaker will use Korean.");
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
            silence_duration_ms: 550,
          },
        },
      },
    });
  });

  it("omits manual source details when auto-detect is enabled", () => {
    const settings = {
      targetLanguage: "ja",
      sourceLanguageMode: "auto" as const,
      sourceLanguage: "ko",
    };

    const prompt = buildTranscriptionPrompt(settings);
    const instructions = buildTranslatorInstructions(settings);
    const request = buildClientSecretRequest(settings);

    expect(prompt).not.toContain("spoken language will be");
    expect(instructions).toContain("Translate every completed user utterance into Japanese.");
    expect(instructions).toContain("Detect the speaker's source language automatically for each turn.");
    expect(request.expires_after.seconds).toBe(600);
    expect(request.session.audio.input.transcription).not.toHaveProperty("language");
  });
});
