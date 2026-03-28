import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { getLanguageByCode, getLanguageLabel } from "@/lib/languages";
import type { RealtimeProvider } from "@/lib/realtime-config";
import {
  getRealtimeProviderErrorMessage,
  resolveConfiguredRealtimeProvider,
} from "@/lib/realtime-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SpeakRequestBody = {
  provider?: RealtimeProvider;
  targetLanguage?: string;
  text?: string;
};

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

function getOpenAITtsModel() {
  return process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
}

function getOpenAITtsVoice() {
  return process.env.OPENAI_TTS_VOICE ?? "marin";
}

function getGeminiTtsModel() {
  return process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
}

function getGeminiTtsVoice() {
  return process.env.GEMINI_TTS_VOICE ?? "Achird";
}

function getSpeechLocale(targetLanguage: string) {
  return getLanguageByCode(targetLanguage)?.locale ?? "en-US";
}

function normalizeRequestBody(value: unknown): { provider?: RealtimeProvider; targetLanguage: string; text: string } | null {
  if (typeof value !== "object" || !value) {
    return null;
  }

  const candidate = value as SpeakRequestBody;
  if (
    (candidate.provider !== undefined && candidate.provider !== "openai" && candidate.provider !== "gemini") ||
    typeof candidate.targetLanguage !== "string" ||
    typeof candidate.text !== "string"
  ) {
    return null;
  }

  return {
    provider: candidate.provider,
    targetLanguage: candidate.targetLanguage,
    text: candidate.text,
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function buildSpeechInstructions(targetLanguage: string) {
  const targetLabel = getLanguageLabel(targetLanguage);

  return [
    `Speak in natural, idiomatic ${targetLabel}.`,
    "Sound warm, human, and conversational rather than robotic.",
    "Use smooth pacing like a professional interpreter.",
    "Read only the provided translated text and do not add extra words.",
  ].join(" ");
}

function buildGeminiSpeechPrompt(text: string, targetLanguage: string) {
  return [
    buildSpeechInstructions(targetLanguage),
    "Translated text:",
    text,
  ].join("\n\n");
}

function createWavFile(
  pcmData: Buffer,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16,
) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);

  return buffer;
}

async function readErrorResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const payload = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof payload.error === "string") {
      return payload.error;
    }

    return payload.error?.message ?? text;
  } catch {
    return text;
  }
}

function getGeminiAudioData(response: {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          data?: string;
        };
      }>;
    };
  }>;
}) {
  return response.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .find((part) => typeof part.inlineData?.data === "string")
    ?.inlineData?.data;
}

async function createGeminiSpeech(text: string, targetLanguage: string) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY or GOOGLE_API_KEY is missing on the server." },
      { status: 500 },
    );
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: getGeminiTtsModel(),
      contents: buildGeminiSpeechPrompt(text, targetLanguage),
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: getSpeechLocale(targetLanguage),
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: getGeminiTtsVoice(),
            },
          },
        },
      },
    });

    const audioData = getGeminiAudioData(response);
    if (typeof audioData !== "string") {
      return NextResponse.json(
        { error: "Gemini TTS did not return audio data." },
        { status: 502 },
      );
    }

    const wavBuffer = createWavFile(Buffer.from(audioData, "base64"));
    return new Response(wavBuffer, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "audio/wav",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Could not create Gemini speech: ${getErrorMessage(error, "Gemini TTS failed.")}`,
      },
      { status: 502 },
    );
  }
}

async function createOpenAISpeech(text: string, targetLanguage: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is missing on the server." },
      { status: 500 },
    );
  }

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getOpenAITtsModel(),
        voice: getOpenAITtsVoice(),
        input: text,
        instructions: buildSpeechInstructions(targetLanguage),
        response_format: "wav",
        speed: 0.96,
      }),
      cache: "no-store",
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not reach OpenAI TTS: ${getErrorMessage(error, "OpenAI TTS failed.")}` },
      { status: 502 },
    );
  }

  if (!upstreamResponse.ok) {
    return NextResponse.json(
      { error: await readErrorResponse(upstreamResponse) },
      { status: upstreamResponse.status },
    );
  }

  return new Response(await upstreamResponse.arrayBuffer(), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "audio/wav",
    },
  });
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const normalized = normalizeRequestBody(body);
  if (!normalized) {
    return NextResponse.json(
      { error: "Expected provider, targetLanguage, and text in the request body." },
      { status: 400 },
    );
  }

  if (!getLanguageByCode(normalized.targetLanguage)) {
    return NextResponse.json(
      { error: "targetLanguage must be one of the supported language codes." },
      { status: 400 },
    );
  }

  const text = normalized.text.trim();
  if (!text) {
    return NextResponse.json(
      { error: "text must contain translated speech output." },
      { status: 400 },
    );
  }

  const provider = resolveConfiguredRealtimeProvider(normalized.provider);
  if (!provider) {
    return NextResponse.json(
      { error: getRealtimeProviderErrorMessage() },
      { status: 500 },
    );
  }

  return provider === "gemini"
    ? createGeminiSpeech(text, normalized.targetLanguage)
    : createOpenAISpeech(text, normalized.targetLanguage);
}

