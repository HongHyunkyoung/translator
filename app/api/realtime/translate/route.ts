import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { getLanguageByCode } from "@/lib/languages";
import {
  buildTranslatorInstructions,
  getGeminiTranslationModel,
  normalizeProvider,
  type RealtimeProvider,
  type TranslatorSettings,
} from "@/lib/realtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TranslationRequestBody = {
  provider?: RealtimeProvider;
  transcript?: string;
  settings?: TranslatorSettings;
};

function isSupportedLanguage(code: string | undefined) {
  return Boolean(code && getLanguageByCode(code));
}

function normalizeRequestBody(value: unknown): { provider: RealtimeProvider; transcript: string; settings: TranslatorSettings } | null {
  if (typeof value !== "object" || !value) {
    return null;
  }

  const candidate = value as TranslationRequestBody;
  const settings = candidate.settings;

  if (
    typeof candidate.transcript !== "string" ||
    !settings ||
    typeof settings.targetLanguage !== "string" ||
    (settings.sourceLanguageMode !== "auto" && settings.sourceLanguageMode !== "manual") ||
    (settings.sourceLanguage !== undefined && typeof settings.sourceLanguage !== "string")
  ) {
    return null;
  }

  return {
    provider: normalizeProvider(candidate.provider ?? settings.provider),
    transcript: candidate.transcript,
    settings: {
      provider: normalizeProvider(settings.provider),
      targetLanguage: settings.targetLanguage,
      sourceLanguageMode: settings.sourceLanguageMode,
      sourceLanguage: settings.sourceLanguage,
    },
  };
}

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Gemini translation failed.";
}

export async function POST(request: Request) {
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY or GOOGLE_API_KEY is missing on the server." },
      { status: 500 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const normalized = normalizeRequestBody(body);

  if (!normalized) {
    return NextResponse.json(
      {
        error:
          "Expected provider, transcript, and settings with targetLanguage, sourceLanguageMode, and optional sourceLanguage.",
      },
      { status: 400 },
    );
  }

  if (normalized.provider !== "gemini") {
    return NextResponse.json(
      { error: "The translation route currently supports only the Gemini provider." },
      { status: 400 },
    );
  }

  if (!isSupportedLanguage(normalized.settings.targetLanguage)) {
    return NextResponse.json(
      { error: "targetLanguage must be one of the supported language codes." },
      { status: 400 },
    );
  }

  if (
    normalized.settings.sourceLanguageMode === "manual" &&
    !normalized.settings.sourceLanguage
  ) {
    return NextResponse.json(
      { error: "sourceLanguage is required when sourceLanguageMode is manual." },
      { status: 400 },
    );
  }

  if (
    normalized.settings.sourceLanguageMode === "manual" &&
    !isSupportedLanguage(normalized.settings.sourceLanguage)
  ) {
    return NextResponse.json(
      { error: "sourceLanguage must be one of the supported language codes." },
      { status: 400 },
    );
  }

  const transcript = normalized.transcript.trim();
  if (!transcript) {
    return NextResponse.json(
      { error: "transcript must contain translated source text." },
      { status: 400 },
    );
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = getGeminiTranslationModel();
    const response = await ai.models.generateContent({
      model,
      contents: transcript,
      config: {
        systemInstruction: buildTranslatorInstructions(normalized.settings),
        temperature: 0.2,
      },
    });

    const text = response.text?.trim();

    if (!text) {
      return NextResponse.json(
        { error: "Gemini did not return translated text." },
        { status: 502 },
      );
    }

    return NextResponse.json({ text, model });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not translate with Gemini: ${getErrorMessage(error)}` },
      { status: 502 },
    );
  }
}
