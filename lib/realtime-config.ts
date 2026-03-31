import { getLanguageByCode, getLanguageLabel } from "@/lib/languages";

export type RealtimeProvider = "openai" | "gemini";
export type SourceLanguageMode = "auto" | "manual";

export type TranslatorSettings = {
  provider: RealtimeProvider;
  targetLanguage: string;
  sourceLanguageMode: SourceLanguageMode;
  sourceLanguage?: string;
};

export type OpenAIRealtimeSessionConfig = {
  type: "realtime";
  model: string;
  instructions: string;
  output_modalities: ["text"];
  audio: {
    input: {
      noise_reduction: {
        type: "near_field";
      };
      transcription: {
        model: string;
        prompt: string;
        language?: string;
      };
      turn_detection: {
        type: "server_vad";
        create_response: false;
        interrupt_response: false;
        prefix_padding_ms: number;
        silence_duration_ms: number;
      };
    };
  };
};

export type GeminiLiveSessionConfig = {
  model: `models/${string}`;
  generationConfig: {
    responseModalities: ["AUDIO"];
    maxOutputTokens: number;
    temperature: number;
  };
  inputAudioTranscription: {};
  realtimeInputConfig: {
    automaticActivityDetection: {
      prefixPaddingMs: number;
      silenceDurationMs: number;
    };
  };
  systemInstruction: {
    parts: [{ text: string }];
  };
};

export type RealtimeSessionConfig =
  | OpenAIRealtimeSessionConfig
  | GeminiLiveSessionConfig;

export type ClientSecretRequest = {
  expires_after: {
    anchor: "created_at";
    seconds: number;
  };
  session: OpenAIRealtimeSessionConfig;
};

export function normalizeProvider(value: unknown): RealtimeProvider {
  return value === "gemini" ? "gemini" : "openai";
}

export function getRealtimeModel() {
  return process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
}

export function getTranscriptionModel() {
  return process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe";
}

export function getGeminiLiveModel() {
  return process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025";
}

export function getGeminiTranslationModel() {
  return process.env.GEMINI_TRANSLATION_MODEL ?? "gemini-2.5-flash";
}

export function buildTranslatorInstructions(settings: TranslatorSettings) {
  const targetLabel = getLanguageLabel(settings.targetLanguage);
  const sourceDirective =
    settings.sourceLanguageMode === "manual" && settings.sourceLanguage
      ? `The speaker will use ${getLanguageLabel(settings.sourceLanguage)}.`
      : "Detect the speaker's source language automatically for each turn.";

  return [
    "You are a real-time interpreter for live speech.",
    `Translate every completed user utterance into ${targetLabel}.`,
    "Output only the translated text.",
    "Make the translation sound natural, conversational, and native in the target language instead of literal or robotic.",
    "Prefer everyday phrasing and idiomatic wording when it preserves the speaker's meaning.",
    "Match the speaker's tone and level of formality, but default to relaxed spoken language unless the source is clearly formal.",
    "Do not answer questions, add commentary, explain context, or mention that you are translating.",
    "Do not transliterate unless the target language normally requires it for readability.",
    "Preserve tone, intent, proper nouns, numbers, and obvious line breaks.",
    "If any audio is unclear, translate only the intelligible portion and never invent missing content.",
    sourceDirective,
  ].join(" ");
}

export function buildTranscriptionPrompt(settings: TranslatorSettings) {
  const manualSource =
    settings.sourceLanguageMode === "manual" && settings.sourceLanguage
      ? `The spoken language will be ${getLanguageLabel(settings.sourceLanguage)}. `
      : "";

  return [
    manualSource,
    "Transcribe the speech exactly as spoken.",
    "Preserve punctuation, capitalization, and code-switching.",
    "Do not translate or summarize.",
  ]
    .join("")
    .trim();
}

export function buildRealtimeSessionConfig(
  settings: TranslatorSettings,
): OpenAIRealtimeSessionConfig {
  const sourceLanguage =
    settings.sourceLanguageMode === "manual"
      ? getLanguageByCode(settings.sourceLanguage)?.code
      : undefined;

  return {
    type: "realtime",
    model: getRealtimeModel(),
    instructions: buildTranslatorInstructions(settings),
    output_modalities: ["text"],
    audio: {
      input: {
        noise_reduction: {
          type: "near_field",
        },
        transcription: {
          model: getTranscriptionModel(),
          prompt: buildTranscriptionPrompt(settings),
          ...(sourceLanguage ? { language: sourceLanguage } : {}),
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
  };
}

export function buildGeminiLiveSessionConfig(): GeminiLiveSessionConfig {
  return {
    model: `models/${getGeminiLiveModel()}`,
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
  };
}

export function buildClientSecretRequest(settings: TranslatorSettings): ClientSecretRequest {
  return {
    expires_after: {
      anchor: "created_at",
      seconds: 600,
    },
    session: buildRealtimeSessionConfig(settings),
  };
}

