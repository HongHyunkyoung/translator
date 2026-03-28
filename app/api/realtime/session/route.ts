import { GoogleGenAI, Modality } from "@google/genai";
import { NextResponse } from "next/server";
import { getLanguageByCode } from "@/lib/languages";
import {
  buildClientSecretRequest,
  buildGeminiLiveSessionConfig,
  buildRealtimeSessionConfig,
  getGeminiLiveModel,
  getGeminiTranslationModel,
  getRealtimeModel,
  getTranscriptionModel,
  type RealtimeProvider,
  type TranslatorSettings,
} from "@/lib/realtime-config";
import {
  getRealtimeProviderErrorMessage,
  normalizeRealtimeProvider,
  resolveConfiguredRealtimeProvider,
} from "@/lib/realtime-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionRouteResponse =
  | {
      provider: "openai";
      ephemeralKey: string;
      model: string;
      transcriptionModel: string;
      sessionConfig: ReturnType<typeof buildRealtimeSessionConfig>;
    }
  | {
      provider: "gemini";
      ephemeralKey: string;
      model: string;
      translationModel: string;
      sessionConfig: ReturnType<typeof buildGeminiLiveSessionConfig>;
    };

type SessionRequestBody = Omit<TranslatorSettings, "provider"> & {
  provider?: RealtimeProvider;
};

function normalizeTranslatorSettings(value: unknown): SessionRequestBody | null {
  if (typeof value !== "object" || !value) {
    return null;
  }

  const candidate = value as Partial<TranslatorSettings> & { provider?: RealtimeProvider };

  if (
    typeof candidate.targetLanguage !== "string" ||
    candidate.targetLanguage.length === 0 ||
    (candidate.sourceLanguageMode !== "auto" && candidate.sourceLanguageMode !== "manual") ||
    (candidate.sourceLanguage !== undefined && typeof candidate.sourceLanguage !== "string")
  ) {
    return null;
  }

  return {
    provider: normalizeRealtimeProvider(candidate.provider) ?? undefined,
    targetLanguage: candidate.targetLanguage,
    sourceLanguageMode: candidate.sourceLanguageMode,
    sourceLanguage: candidate.sourceLanguage,
  };
}

function isSupportedLanguage(code: string | undefined) {
  return Boolean(code && getLanguageByCode(code));
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

async function createOpenAISession(settings: TranslatorSettings): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is missing on the server." },
      { status: 500 },
    );
  }

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildClientSecretRequest(settings)),
      cache: "no-store",
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not reach OpenAI: ${getErrorMessage(error, "OpenAI session creation failed.")}` },
      { status: 502 },
    );
  }

  const upstreamText = await upstreamResponse.text();
  let upstreamPayload: Record<string, unknown> | null = null;

  if (upstreamText) {
    try {
      upstreamPayload = JSON.parse(upstreamText) as Record<string, unknown>;
    } catch {
      upstreamPayload = null;
    }
  }

  if (!upstreamResponse.ok) {
    const errorMessage =
      typeof upstreamPayload?.error === "object" &&
      upstreamPayload.error &&
      "message" in upstreamPayload.error &&
      typeof upstreamPayload.error.message === "string"
        ? upstreamPayload.error.message
        : upstreamText || "OpenAI session creation failed.";

    return NextResponse.json({ error: errorMessage }, { status: upstreamResponse.status });
  }

  const ephemeralKey =
    typeof upstreamPayload?.value === "string"
      ? upstreamPayload.value
      : typeof upstreamPayload?.client_secret === "object" &&
          upstreamPayload.client_secret &&
          "value" in upstreamPayload.client_secret &&
          typeof upstreamPayload.client_secret.value === "string"
        ? upstreamPayload.client_secret.value
        : null;

  if (!ephemeralKey) {
    return NextResponse.json(
      { error: "OpenAI did not return a usable ephemeral key." },
      { status: 502 },
    );
  }

  const payload: SessionRouteResponse = {
    provider: "openai",
    ephemeralKey,
    model: getRealtimeModel(),
    transcriptionModel: getTranscriptionModel(),
    sessionConfig: buildRealtimeSessionConfig(settings),
  };

  return NextResponse.json(payload);
}

async function createGeminiSession(): Promise<Response> {
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY or GOOGLE_API_KEY is missing on the server." },
      { status: 500 },
    );
  }

  try {
    const sessionConfig = buildGeminiLiveSessionConfig();
    const ai = new GoogleGenAI({ apiKey });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: getGeminiLiveModel(),
          config: {
            responseModalities: [Modality.AUDIO],
            maxOutputTokens: sessionConfig.generationConfig.maxOutputTokens,
            temperature: sessionConfig.generationConfig.temperature,
            inputAudioTranscription: sessionConfig.inputAudioTranscription,
            realtimeInputConfig: sessionConfig.realtimeInputConfig,
            systemInstruction: sessionConfig.systemInstruction,
          },
        },
        httpOptions: {
          apiVersion: "v1alpha",
        },
      },
    });

    if (!token.name) {
      return NextResponse.json(
        { error: "Gemini did not return a usable ephemeral token." },
        { status: 502 },
      );
    }

    const payload: SessionRouteResponse = {
      provider: "gemini",
      ephemeralKey: token.name,
      model: getGeminiLiveModel(),
      translationModel: getGeminiTranslationModel(),
      sessionConfig,
    };

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      {
        error: `Could not create Gemini Live session: ${getErrorMessage(error, "Gemini session creation failed.")}`,
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const requestedSettings = normalizeTranslatorSettings(body);

  if (!requestedSettings) {
    return NextResponse.json(
      {
        error:
          "Expected targetLanguage, sourceLanguageMode, and optional sourceLanguage in the request body.",
      },
      { status: 400 },
    );
  }

  if (!isSupportedLanguage(requestedSettings.targetLanguage)) {
    return NextResponse.json(
      { error: "targetLanguage must be one of the supported language codes." },
      { status: 400 },
    );
  }

  if (requestedSettings.sourceLanguageMode === "manual" && !requestedSettings.sourceLanguage) {
    return NextResponse.json(
      { error: "sourceLanguage is required when sourceLanguageMode is manual." },
      { status: 400 },
    );
  }

  if (
    requestedSettings.sourceLanguageMode === "manual" &&
    !isSupportedLanguage(requestedSettings.sourceLanguage)
  ) {
    return NextResponse.json(
      { error: "sourceLanguage must be one of the supported language codes." },
      { status: 400 },
    );
  }

  const provider = resolveConfiguredRealtimeProvider(requestedSettings.provider);
  if (!provider) {
    return NextResponse.json(
      { error: getRealtimeProviderErrorMessage() },
      { status: 500 },
    );
  }

  const settings: TranslatorSettings = {
    ...requestedSettings,
    provider,
  };

  return provider === "gemini"
    ? createGeminiSession()
    : createOpenAISession(settings);
}
