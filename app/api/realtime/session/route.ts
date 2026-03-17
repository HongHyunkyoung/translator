import { NextResponse } from "next/server";
import { getLanguageByCode } from "@/lib/languages";
import {
  buildClientSecretRequest,
  buildRealtimeSessionConfig,
  getRealtimeModel,
  getTranscriptionModel,
  type TranslatorSettings,
} from "@/lib/realtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isTranslatorSettings(value: unknown): value is TranslatorSettings {
  if (typeof value !== "object" || !value) {
    return false;
  }

  const candidate = value as Partial<TranslatorSettings>;
  return (
    typeof candidate.targetLanguage === "string" &&
    candidate.targetLanguage.length > 0 &&
    (candidate.sourceLanguageMode === "auto" || candidate.sourceLanguageMode === "manual") &&
    (candidate.sourceLanguage === undefined || typeof candidate.sourceLanguage === "string")
  );
}

function isSupportedLanguage(code: string | undefined) {
  return Boolean(code && getLanguageByCode(code));
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "OpenAI session creation failed.";
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is missing on the server." },
      { status: 500 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isTranslatorSettings(body)) {
    return NextResponse.json(
      {
        error:
          "Expected targetLanguage, sourceLanguageMode, and optional sourceLanguage in the request body.",
      },
      { status: 400 },
    );
  }

  if (!isSupportedLanguage(body.targetLanguage)) {
    return NextResponse.json(
      { error: "targetLanguage must be one of the supported language codes." },
      { status: 400 },
    );
  }

  if (body.sourceLanguageMode === "manual" && !body.sourceLanguage) {
    return NextResponse.json(
      { error: "sourceLanguage is required when sourceLanguageMode is manual." },
      { status: 400 },
    );
  }

  if (
    body.sourceLanguageMode === "manual" &&
    !isSupportedLanguage(body.sourceLanguage)
  ) {
    return NextResponse.json(
      { error: "sourceLanguage must be one of the supported language codes." },
      { status: 400 },
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
      body: JSON.stringify(buildClientSecretRequest(body)),
      cache: "no-store",
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not reach OpenAI: ${getErrorMessage(error)}` },
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

  return NextResponse.json({
    ephemeralKey,
    model: getRealtimeModel(),
    transcriptionModel: getTranscriptionModel(),
    sessionConfig: buildRealtimeSessionConfig(body),
  });
}
