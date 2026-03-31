import {
  buildRealtimeSessionConfig,
  type GeminiLiveSessionConfig,
  type OpenAIRealtimeSessionConfig,
  type RealtimeProvider,
  type TranslatorSettings,
} from "@/lib/realtime-config";
import type { ConnectionStatus } from "@/lib/realtime-store";

type OpenAISessionResponse = {
  provider: "openai";
  ephemeralKey: string;
  model: string;
  transcriptionModel: string;
  sessionConfig: OpenAIRealtimeSessionConfig;
};

type GeminiSessionResponse = {
  provider: "gemini";
  ephemeralKey: string;
  model: string;
  translationModel: string;
  sessionConfig: GeminiLiveSessionConfig;
};

type SessionResponse = OpenAISessionResponse | GeminiSessionResponse;

function isOpenAISessionResponse(value: unknown): value is OpenAISessionResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "openai" &&
    "ephemeralKey" in value &&
    typeof value.ephemeralKey === "string" &&
    "sessionConfig" in value
  );
}

function isGeminiSessionResponse(value: unknown): value is GeminiSessionResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "gemini" &&
    "ephemeralKey" in value &&
    typeof value.ephemeralKey === "string" &&
    "sessionConfig" in value
  );
}

export type ClientConnectOptions = {
  settings: TranslatorSettings;
};

export type TranslationRequestOptions = {
  enableAudio?: boolean;
};

export type RealtimeClientCallbacks = {
  onConnectionStatus: (status: ConnectionStatus) => void;
  onError: (message: string) => void;
  onRateLimit: (message: string | null) => void;
  onInputLevel: (level: number) => void;
  onOutputAudioStateChange: (isPlaying: boolean) => void;
  onTurnCommitted: (payload: {
    itemId: string;
    previousItemId: string | null;
    sourceLanguage: string | null;
  }) => void;
  onTranscriptDelta: (payload: { itemId: string; delta: string }) => void;
  onTranscriptCompleted: (payload: { itemId: string; transcript: string }) => void;
  onResponseCreated: (payload: { responseId: string; itemId?: string }) => void;
  onTranslationDelta: (payload: {
    responseId?: string;
    itemId?: string;
    delta: string;
  }) => void;
  onTranslationOutputDone: (payload: {
    responseId?: string;
    itemId?: string;
    text: string;
  }) => void;
  onResponseDone: (payload: {
    responseId?: string;
    itemId?: string;
    failedMessage?: string | null;
  }) => void;
};

export interface TranslatorClient {
  connect(options: ClientConnectOptions): Promise<void>;
  disconnect(): void;
  updateSettings(settings: TranslatorSettings): void;
  requestTranslation(
    itemId: string,
    settings: TranslatorSettings,
    options?: TranslationRequestOptions,
  ): void;
  setInputMuted(muted: boolean): void;
}

type RealtimeServerEvent = {
  type: string;
  [key: string]: unknown;
};

type GeminiServerMessage = {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    inputTranscription?: {
      text?: unknown;
      finished?: unknown;
    };
    turnComplete?: unknown;
  };
  error?: unknown;
};

function normalizeErrorMessage(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (
    typeof value === "object" &&
    value &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return value.message;
  }

  return "The realtime provider returned an unexpected error.";
}

const RATE_LIMIT_WARNING_THRESHOLD = 5000;

export function formatRateLimitMessage(rateLimits: unknown) {
  if (!Array.isArray(rateLimits) || rateLimits.length === 0) {
    return null;
  }

  const primary = rateLimits.find(
    (entry) =>
      typeof entry === "object" &&
      entry &&
      "name" in entry &&
      typeof entry.name === "string",
  ) as
    | {
        name?: string;
        remaining?: number;
        reset_seconds?: number;
      }
    | undefined;

  if (!primary?.name || typeof primary.remaining !== "number") {
    return null;
  }

  if (primary.remaining > RATE_LIMIT_WARNING_THRESHOLD) {
    return null;
  }

  const resetSeconds =
    typeof primary.reset_seconds === "number"
      ? `${Math.ceil(primary.reset_seconds)}s`
      : "shortly";

  return `Realtime usage is getting close to the limit. Resets in ${resetSeconds}.`;
}

function getStringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export async function extractGeminiServerEventText(rawData: unknown) {
  if (typeof rawData === "string") {
    return rawData.trimStart().startsWith("{") ? rawData : null;
  }

  if (
    rawData instanceof ArrayBuffer ||
    Object.prototype.toString.call(rawData) === "[object ArrayBuffer]"
  ) {
    const text = new TextDecoder().decode(rawData as ArrayBuffer);
    return text.trimStart().startsWith("{") ? text : null;
  }

  if (ArrayBuffer.isView(rawData)) {
    const text = new TextDecoder().decode(rawData);
    return text.trimStart().startsWith("{") ? text : null;
  }

  if (typeof Blob !== "undefined" && rawData instanceof Blob) {
    const text = await rawData.text();
    return text.trimStart().startsWith("{") ? text : null;
  }

  return null;
}

export type ParsedGeminiServerEvent = {
  setupComplete: boolean;
  turnComplete: boolean;
  inputTranscription?: {
    text: string;
    finished: boolean;
  };
  errorMessage?: string;
};

export function parseGeminiServerEvent(rawEvent: string): ParsedGeminiServerEvent {
  let message: GeminiServerMessage;

  try {
    message = JSON.parse(rawEvent) as GeminiServerMessage;
  } catch {
    return {
      setupComplete: false,
      turnComplete: false,
      errorMessage: "Received a malformed event from Gemini Live.",
    };
  }

  if (message.error) {
    return {
      setupComplete: false,
      turnComplete: false,
      errorMessage: normalizeErrorMessage(message.error),
    };
  }

  return {
    setupComplete: Boolean(message.setupComplete),
    turnComplete: message.serverContent?.turnComplete === true,
    inputTranscription: message.serverContent?.inputTranscription
      ? {
          text: getStringValue(message.serverContent.inputTranscription.text) ?? "",
          finished: message.serverContent.inputTranscription.finished === true,
        }
      : undefined,
  };
}
export function mergeGeminiTranscript(existingText: string, incomingText: string) {
  if (!incomingText) {
    return existingText;
  }

  if (!existingText) {
    return incomingText;
  }

  if (incomingText.startsWith(existingText)) {
    return incomingText;
  }

  if (existingText.startsWith(incomingText)) {
    return existingText;
  }

  const maxOverlap = Math.min(existingText.length, incomingText.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existingText.endsWith(incomingText.slice(0, overlap))) {
      return existingText + incomingText.slice(overlap);
    }
  }

  return existingText + incomingText;
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

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function downsampleTo16BitPcm(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16000,
) {
  if (input.length === 0) {
    return new Int16Array();
  }

  if (inputSampleRate === outputSampleRate) {
    const direct = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
      direct[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return direct;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(input.length / sampleRateRatio));
  const result = new Int16Array(outputLength);
  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < outputLength) {
    const nextInputIndex = Math.min(
      input.length,
      Math.round((outputIndex + 1) * sampleRateRatio),
    );

    let total = 0;
    let count = 0;
    for (let index = inputIndex; index < nextInputIndex; index += 1) {
      total += input[index] ?? 0;
      count += 1;
    }

    const sample = count > 0 ? total / count : (input[inputIndex] ?? 0);
    const clamped = Math.max(-1, Math.min(1, sample));
    result[outputIndex] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

    outputIndex += 1;
    inputIndex = nextInputIndex;
  }

  return result;
}

function clampInputLevel(level: number) {
  return Math.max(0, Math.min(1, level));
}

function measureInputLevel(samples: Float32Array) {
  if (samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  return clampInputLevel(rms * 4.5);
}

function measureByteInputLevel(samples: ArrayLike<number>) {
  if (samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = ((samples[index] ?? 128) - 128) / 128;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  return clampInputLevel(rms * 4.5);
}

class OpenAIRealtimeTranslatorClient implements TranslatorClient {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private mediaStream: MediaStream | null = null;
  private sessionConfig: OpenAIRealtimeSessionConfig | null = null;
  private settings: TranslatorSettings | null = null;
  private pendingTranslationTurnId: string | null = null;
  private inputMuted = false;
  private meterContext: AudioContext | null = null;
  private meterSourceNode: MediaStreamAudioSourceNode | null = null;
  private meterAnalyserNode: AnalyserNode | null = null;
  private meterFrameId: number | null = null;
  private meterSamples: Uint8Array<ArrayBuffer> | null = null;
  private lastInputLevel = 0;
  private remoteAudioElement: HTMLAudioElement | null = null;
  private remoteAudioStream: MediaStream | null = null;
  private activeOutputAudioResponseIds = new Set<string>();
  private outputAudioActive = false;

  constructor(private readonly callbacks: RealtimeClientCallbacks) {}

  async connect({ settings }: ClientConnectOptions) {
    this.disconnect();
    this.settings = settings;
    this.inputMuted = false;
    this.lastInputLevel = 0;

    this.callbacks.onConnectionStatus("requesting-permission");

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      void this.startInputLevelMeter();
    } catch {
      this.callbacks.onConnectionStatus("error");
      throw new Error("Microphone access was denied. Allow microphone access and try again.");
    }

    this.setInputMuted(false);
    this.callbacks.onConnectionStatus("connecting");

    const sessionResponse = await this.createSession(settings);
    this.sessionConfig = sessionResponse.sessionConfig;

    const peerConnection = new RTCPeerConnection();
    this.peerConnection = peerConnection;

    if (typeof Audio !== "undefined") {
      const remoteAudioElement = new Audio();
      remoteAudioElement.autoplay = true;
      remoteAudioElement.preload = "auto";
      remoteAudioElement.muted = false;
      remoteAudioElement.volume = 1;
      (remoteAudioElement as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      this.remoteAudioElement = remoteAudioElement;
    }

    this.mediaStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, this.mediaStream as MediaStream);
    });

    peerConnection.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream || !this.remoteAudioElement) {
        return;
      }

      if (this.remoteAudioStream === stream) {
        return;
      }

      this.remoteAudioStream = stream;
      this.remoteAudioElement.srcObject = stream;
      void this.remoteAudioElement.play().catch(() => {
        // Ignore autoplay failures; the user can replay with the fallback route.
      });
    };

    peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection) {
        return;
      }

      const state = this.peerConnection.connectionState;
      if (state === "connected") {
        this.callbacks.onConnectionStatus("connected");
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
        this.handleOutputAudioPlaybackEnded();
        this.callbacks.onConnectionStatus("error");
      }
    };

    const dataChannel = peerConnection.createDataChannel("oai-events");
    this.dataChannel = dataChannel;

    dataChannel.addEventListener("message", (messageEvent) => {
      this.handleServerEvent(messageEvent.data);
    });

    dataChannel.addEventListener("close", () => {
      this.callbacks.onConnectionStatus("idle");
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + sessionResponse.ephemeralKey,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!response.ok) {
      const message = await readErrorResponse(response);
      this.callbacks.onConnectionStatus("error");
      throw new Error("Realtime connection failed: " + message);
    }

    const answer = await response.text();
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answer,
    });
  }

  disconnect() {
    this.pendingTranslationTurnId = null;
    this.handleOutputAudioPlaybackEnded();

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.remoteAudioElement) {
      this.remoteAudioElement.pause();
      this.remoteAudioElement.srcObject = null;
      this.remoteAudioElement = null;
    }
    this.remoteAudioStream = null;

    this.stopInputLevelMeter();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.inputMuted = false;
    this.lastInputLevel = 0;
    this.callbacks.onInputLevel(0);
    this.callbacks.onConnectionStatus("idle");
  }

  updateSettings(settings: TranslatorSettings) {
    this.settings = settings;
    this.sessionConfig = buildRealtimeSessionConfig(settings);

    if (this.dataChannel?.readyState === "open") {
      this.sendEvent({
        type: "session.update",
        session: this.sessionConfig,
      });
    }
  }

  requestTranslation(
    itemId: string,
    settings: TranslatorSettings,
    options?: TranslationRequestOptions,
  ) {
    this.settings = settings;
    this.pendingTranslationTurnId = itemId;

    this.sendEvent({
      type: "response.create",
      response: {
        conversation: "none",
        input: [
          {
            type: "item_reference",
            id: itemId,
          },
        ],
        output_modalities: options?.enableAudio === false ? ["text"] : ["audio"],
        metadata: {
          turn_item_id: itemId,
          target_language: settings.targetLanguage,
        },
        instructions: this.sessionConfig?.instructions,
      },
    });
  }

  setInputMuted(muted: boolean) {
    this.inputMuted = muted;

    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }

    if (muted) {
      this.lastInputLevel = 0;
      this.callbacks.onInputLevel(0);
    }
  }

  private handleOutputAudioPlaybackStarted(responseId?: string) {
    if (responseId) {
      this.activeOutputAudioResponseIds.add(responseId);
    }

    if (this.outputAudioActive) {
      return;
    }

    this.outputAudioActive = true;
    this.setInputMuted(true);
    this.callbacks.onOutputAudioStateChange(true);
  }

  private handleOutputAudioPlaybackEnded(responseId?: string) {
    if (responseId) {
      this.activeOutputAudioResponseIds.delete(responseId);
    } else {
      this.activeOutputAudioResponseIds.clear();
    }

    if (!this.outputAudioActive || this.activeOutputAudioResponseIds.size > 0) {
      return;
    }

    this.outputAudioActive = false;
    this.setInputMuted(false);
    this.callbacks.onOutputAudioStateChange(false);
  }

  private async createSession(settings: TranslatorSettings) {
    const response = await fetch("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });

    const payload = (await response.json().catch(() => null)) as
      | SessionResponse
      | { error?: string }
      | null;

    if (!response.ok || !isOpenAISessionResponse(payload)) {
      const message =
        payload && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Could not create an OpenAI Realtime session.";
      throw new Error(message);
    }

    return payload;
  }

  private handleServerEvent(rawEvent: string) {
    let event: RealtimeServerEvent;

    try {
      event = JSON.parse(rawEvent) as RealtimeServerEvent;
    } catch {
      this.callbacks.onError("Received a malformed event from the realtime provider.");
      return;
    }

    switch (event.type) {
      case "session.created":
        if (this.sessionConfig) {
          this.sendEvent({
            type: "session.update",
            session: this.sessionConfig,
          });
        }
        this.callbacks.onConnectionStatus("connected");
        break;
      case "session.updated":
        this.callbacks.onConnectionStatus("connected");
        break;
      case "input_audio_buffer.committed": {
        const itemId = getStringValue(event.item_id);
        if (!itemId) {
          break;
        }

        this.callbacks.onTurnCommitted({
          itemId,
          previousItemId: getStringValue(event.previous_item_id) ?? null,
          sourceLanguage:
            this.settings?.sourceLanguageMode === "manual"
              ? this.settings.sourceLanguage ?? null
              : null,
        });
        break;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const itemId = getStringValue(event.item_id);
        if (!itemId) {
          break;
        }

        this.callbacks.onTranscriptDelta({
          itemId,
          delta: getStringValue(event.delta) ?? "",
        });
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = getStringValue(event.item_id);
        if (!itemId) {
          break;
        }

        this.callbacks.onTranscriptCompleted({
          itemId,
          transcript: getStringValue(event.transcript) ?? "",
        });
        break;
      }
      case "response.created": {
        const response = typeof event.response === "object" && event.response ? event.response : {};
        const responseId =
          "id" in response && typeof response.id === "string" ? response.id : undefined;
        const metadata =
          "metadata" in response && typeof response.metadata === "object" && response.metadata
            ? response.metadata
            : {};
        const mappedItemId =
          "turn_item_id" in metadata && typeof metadata.turn_item_id === "string"
            ? metadata.turn_item_id
            : this.pendingTranslationTurnId ?? undefined;

        if (responseId) {
          this.callbacks.onResponseCreated({
            responseId,
            itemId: mappedItemId,
          });
        }
        break;
      }
      case "response.output_text.delta":
        this.callbacks.onTranslationDelta({
          responseId: getStringValue(event.response_id),
          itemId: this.pendingTranslationTurnId ?? undefined,
          delta: getStringValue(event.delta) ?? "",
        });
        break;
      case "response.output_text.done":
        this.callbacks.onTranslationOutputDone({
          responseId: getStringValue(event.response_id),
          itemId: this.pendingTranslationTurnId ?? undefined,
          text: getStringValue(event.text) ?? "",
        });
        break;
      case "response.output_audio.delta":
        this.handleOutputAudioPlaybackStarted(getStringValue(event.response_id));
        break;
      case "response.output_audio.done":
        this.handleOutputAudioPlaybackEnded(getStringValue(event.response_id));
        break;
      case "response.done": {
        const response = typeof event.response === "object" && event.response ? event.response : {};
        const status =
          "status" in response && typeof response.status === "string"
            ? response.status
            : "completed";
        const responseId =
          "id" in response && typeof response.id === "string" ? response.id : undefined;
        const failedMessage =
          status === "failed"
            ? normalizeErrorMessage(
                "status_details" in response ? response.status_details : undefined,
              )
            : null;

        this.callbacks.onResponseDone({
          responseId,
          itemId: this.pendingTranslationTurnId ?? undefined,
          failedMessage,
        });
        this.handleOutputAudioPlaybackEnded(responseId);
        this.pendingTranslationTurnId = null;
        break;
      }
      case "rate_limits.updated":
        this.callbacks.onRateLimit(formatRateLimitMessage(event.rate_limits));
        break;
      case "error":
        this.handleOutputAudioPlaybackEnded();
        this.callbacks.onError(normalizeErrorMessage(event.error));
        break;
      default:
        break;
    }
  }

  private async startInputLevelMeter() {
    if (!this.mediaStream || typeof window === "undefined" || !window.AudioContext) {
      return;
    }

    this.stopInputLevelMeter();

    const meterContext = new window.AudioContext();
    await meterContext.resume();

    if (!this.mediaStream) {
      await meterContext.close();
      return;
    }

    const meterSourceNode = meterContext.createMediaStreamSource(this.mediaStream);
    const meterAnalyserNode = meterContext.createAnalyser();
    meterAnalyserNode.fftSize = 2048;
    meterAnalyserNode.smoothingTimeConstant = 0.85;
    const meterSamples = new Uint8Array(new ArrayBuffer(meterAnalyserNode.fftSize));

    meterSourceNode.connect(meterAnalyserNode);

    this.meterContext = meterContext;
    this.meterSourceNode = meterSourceNode;
    this.meterAnalyserNode = meterAnalyserNode;
    this.meterSamples = meterSamples;

    const updateMeter = () => {
      if (
        typeof window === "undefined" ||
        this.meterAnalyserNode !== meterAnalyserNode ||
        !this.meterSamples
      ) {
        return;
      }

      meterAnalyserNode.getByteTimeDomainData(this.meterSamples);
      this.emitInputLevel(this.inputMuted ? 0 : measureByteInputLevel(this.meterSamples));
      this.meterFrameId = window.requestAnimationFrame(updateMeter);
    };

    updateMeter();
  }

  private stopInputLevelMeter() {
    if (typeof window !== "undefined" && this.meterFrameId !== null) {
      window.cancelAnimationFrame(this.meterFrameId);
    }
    this.meterFrameId = null;

    if (this.meterSourceNode) {
      this.meterSourceNode.disconnect();
      this.meterSourceNode = null;
    }

    if (this.meterAnalyserNode) {
      this.meterAnalyserNode.disconnect();
      this.meterAnalyserNode = null;
    }

    this.meterSamples = null;

    if (this.meterContext) {
      void this.meterContext.close();
      this.meterContext = null;
    }
  }

  private emitInputLevel(level: number) {
    const nextLevel = this.inputMuted
      ? 0
      : clampInputLevel(this.lastInputLevel * 0.7 + clampInputLevel(level) * 0.3);

    if (Math.abs(nextLevel - this.lastInputLevel) < 0.01 && !(nextLevel === 0 && this.lastInputLevel !== 0)) {
      return;
    }

    this.lastInputLevel = nextLevel;
    this.callbacks.onInputLevel(nextLevel);
  }

  private sendEvent(event: Record<string, unknown>) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("Realtime data channel is not ready yet.");
    }

    this.dataChannel.send(JSON.stringify(event));
  }
}

class GeminiRealtimeTranslatorClient implements TranslatorClient {
  private websocket: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private monitorNode: GainNode | null = null;
  private settings: TranslatorSettings | null = null;
  private transcriptsByItemId = new Map<string, string>();
  private activeTranscriptTurn:
    | {
        itemId: string;
        transcript: string;
      }
    | null = null;
  private previousTurnId: string | null = null;
  private turnCounter = 0;
  private responseCounter = 0;
  private lifecycleToken = 0;
  private disconnecting = false;
  private inputMuted = false;
  private lastInputLevel = 0;

  constructor(private readonly callbacks: RealtimeClientCallbacks) {}

  async connect({ settings }: ClientConnectOptions) {
    this.disconnect();
    this.disconnecting = false;
    this.settings = settings;
    this.inputMuted = false;
    this.lastInputLevel = 0;
    const lifecycleToken = ++this.lifecycleToken;

    this.callbacks.onConnectionStatus("requesting-permission");

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      this.callbacks.onConnectionStatus("error");
      throw new Error("Microphone access was denied. Allow microphone access and try again.");
    }

    this.setInputMuted(false);
    this.callbacks.onConnectionStatus("connecting");

    const sessionResponse = await this.createSession(settings);
    await this.openSocket(sessionResponse, lifecycleToken);
    await this.startAudioPipeline(lifecycleToken);
  }

  disconnect() {
    this.disconnecting = true;
    this.lifecycleToken += 1;
    this.activeTranscriptTurn = null;
    this.transcriptsByItemId.clear();
    this.previousTurnId = null;
    this.turnCounter = 0;
    this.responseCounter = 0;

    if (this.websocket?.readyState === WebSocket.OPEN) {
      try {
        this.websocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      } catch {
        // Ignore send failures during shutdown.
      }
    }

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }

    if (this.monitorNode) {
      this.monitorNode.disconnect();
      this.monitorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.inputMuted = false;
    this.lastInputLevel = 0;
    this.callbacks.onInputLevel(0);
    this.callbacks.onConnectionStatus("idle");
  }

  updateSettings(settings: TranslatorSettings) {
    this.settings = settings;
  }

  requestTranslation(
    itemId: string,
    settings: TranslatorSettings,
    _options?: TranslationRequestOptions,
  ) {
    this.settings = settings;

    const transcript = this.transcriptsByItemId.get(itemId)?.trim();
    if (!transcript) {
      throw new Error("Transcript is not ready for translation yet.");
    }

    const responseId = "gemini-response-" + ++this.responseCounter;
    const lifecycleToken = this.lifecycleToken;

    this.callbacks.onResponseCreated({
      responseId,
      itemId,
    });

    void this.translateWithGemini({
      itemId,
      responseId,
      transcript,
      settings,
      lifecycleToken,
    });
  }

  setInputMuted(muted: boolean) {
    this.inputMuted = muted;

    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    }

    if (muted) {
      this.lastInputLevel = 0;
      this.callbacks.onInputLevel(0);
    }
  }

  private async createSession(settings: TranslatorSettings) {
    const response = await fetch("/api/realtime/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });

    const payload = (await response.json().catch(() => null)) as
      | SessionResponse
      | { error?: string }
      | null;

    if (!response.ok || !isGeminiSessionResponse(payload)) {
      const message =
        payload && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Could not create a Gemini Live session.";
      throw new Error(message);
    }

    return payload;
  }

  private async openSocket(session: GeminiSessionResponse, lifecycleToken: number) {
    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained" +
      "?access_token=" + encodeURIComponent(session.ephemeralKey);

    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(url);
      let resolved = false;
      this.websocket = websocket;

      const rejectOnce = (error: Error) => {
        if (resolved) {
          return;
        }

        resolved = true;
        reject(error);
      };

      websocket.onopen = () => {
        websocket.send(
          JSON.stringify({
            setup: session.sessionConfig,
          }),
        );
      };

      websocket.onmessage = async (event) => {
        try {
          const rawMessage = await extractGeminiServerEventText(event.data);
          if (!rawMessage) {
            return;
          }

          const result = this.handleGeminiMessage(rawMessage);

          if (result.errorMessage) {
            if (!resolved) {
              rejectOnce(new Error(result.errorMessage));
            }
            return;
          }

          if (!resolved && result.setupComplete) {
            resolved = true;
            this.callbacks.onConnectionStatus("connected");
            resolve();
          }
        } catch (error) {
          const message = normalizeErrorMessage(error);
          if (!resolved) {
            rejectOnce(new Error(message));
            return;
          }

          this.callbacks.onError(message);
        }
      };

      websocket.onerror = () => {
        rejectOnce(new Error("Gemini Live connection failed."));
      };

      websocket.onclose = (event) => {
        if (!resolved) {
          rejectOnce(
            new Error(
              event.reason || "Gemini Live connection closed before setup completed.",
            ),
          );
          return;
        }

        if (this.disconnecting || this.lifecycleToken !== lifecycleToken) {
          return;
        }

        this.callbacks.onConnectionStatus("error");
        this.callbacks.onError(event.reason || "Gemini Live session closed unexpectedly.");
      };
    });
  }

  private handleGeminiMessage(rawEvent: string) {
    const event = parseGeminiServerEvent(rawEvent);

    if (event.errorMessage) {
      this.callbacks.onError(event.errorMessage);
      return {
        setupComplete: false,
        errorMessage: event.errorMessage,
      };
    }

    if (event.inputTranscription) {
      this.handleInputTranscription(event.inputTranscription);
    }

    if (event.turnComplete) {
      this.completeActiveTranscript();
    }

    return {
      setupComplete: event.setupComplete,
    };
  }

  private handleInputTranscription(transcription: { text: string; finished: boolean }) {
    const text = transcription.text;
    const finished = transcription.finished;

    if (!text && !finished) {
      return;
    }

    if (!this.activeTranscriptTurn) {
      const itemId = "gemini-turn-" + ++this.turnCounter;
      this.activeTranscriptTurn = {
        itemId,
        transcript: "",
      };

      this.callbacks.onTurnCommitted({
        itemId,
        previousItemId: this.previousTurnId,
        sourceLanguage:
          this.settings?.sourceLanguageMode === "manual"
            ? this.settings.sourceLanguage ?? null
            : null,
      });

      this.previousTurnId = itemId;
    }

    const activeTurn = this.activeTranscriptTurn;
    if (!activeTurn) {
      return;
    }

    const mergedTranscript = text
      ? mergeGeminiTranscript(activeTurn.transcript, text)
      : activeTurn.transcript;
    const delta = mergedTranscript.startsWith(activeTurn.transcript)
      ? mergedTranscript.slice(activeTurn.transcript.length)
      : "";

    if (delta) {
      this.callbacks.onTranscriptDelta({
        itemId: activeTurn.itemId,
        delta,
      });
    }

    activeTurn.transcript = mergedTranscript;

    if (!finished) {
      return;
    }

    this.completeActiveTranscript(mergedTranscript);
  }

  private completeActiveTranscript(transcriptOverride?: string) {
    const activeTurn = this.activeTranscriptTurn;
    if (!activeTurn) {
      return;
    }

    const finalTranscript = (transcriptOverride ?? activeTurn.transcript).trim();
    this.transcriptsByItemId.set(activeTurn.itemId, finalTranscript);
    this.callbacks.onTranscriptCompleted({
      itemId: activeTurn.itemId,
      transcript: finalTranscript,
    });
    this.activeTranscriptTurn = null;
  }

  private async startAudioPipeline(lifecycleToken: number) {
    if (!this.mediaStream) {
      throw new Error("Microphone audio is not available.");
    }

    if (typeof window === "undefined" || !window.AudioContext) {
      throw new Error("This browser does not support the Web Audio API needed for Gemini Live.");
    }

    const audioContext = new window.AudioContext();
    await audioContext.resume();

    const sourceNode = audioContext.createMediaStreamSource(this.mediaStream);
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    const monitorNode = audioContext.createGain();
    monitorNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (this.disconnecting || this.lifecycleToken !== lifecycleToken) {
        return;
      }

      const channelData = event.inputBuffer.getChannelData(0);
      this.emitInputLevel(this.inputMuted ? 0 : measureInputLevel(channelData));

      if (this.inputMuted || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        return;
      }

      const pcm16 = downsampleTo16BitPcm(channelData, audioContext.sampleRate);

      if (pcm16.length === 0) {
        return;
      }

      this.websocket.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: arrayBufferToBase64(pcm16.buffer),
              mimeType: "audio/pcm;rate=16000",
            },
          },
        }),
      );
    };

    sourceNode.connect(processorNode);
    processorNode.connect(monitorNode);
    monitorNode.connect(audioContext.destination);

    this.audioContext = audioContext;
    this.sourceNode = sourceNode;
    this.processorNode = processorNode;
    this.monitorNode = monitorNode;
  }

  private emitInputLevel(level: number) {
    const nextLevel = this.inputMuted
      ? 0
      : clampInputLevel(this.lastInputLevel * 0.7 + clampInputLevel(level) * 0.3);

    if (Math.abs(nextLevel - this.lastInputLevel) < 0.01 && !(nextLevel === 0 && this.lastInputLevel !== 0)) {
      return;
    }

    this.lastInputLevel = nextLevel;
    this.callbacks.onInputLevel(nextLevel);
  }

  private async translateWithGemini(options: {
    itemId: string;
    responseId: string;
    transcript: string;
    settings: TranslatorSettings;
    lifecycleToken: number;
  }) {
    try {
      const response = await fetch("/api/realtime/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "gemini",
          transcript: options.transcript,
          settings: options.settings,
        }),
      });

      if (!response.ok) {
        throw new Error(await readErrorResponse(response));
      }

      const payload = (await response.json()) as { text?: unknown };
      const text = getStringValue(payload.text)?.trim();
      if (!text) {
        throw new Error("Gemini did not return translated text.");
      }

      if (this.lifecycleToken !== options.lifecycleToken) {
        return;
      }

      this.callbacks.onTranslationOutputDone({
        responseId: options.responseId,
        itemId: options.itemId,
        text,
      });
      this.callbacks.onResponseDone({
        responseId: options.responseId,
        itemId: options.itemId,
        failedMessage: null,
      });
    } catch (error) {
      if (this.lifecycleToken !== options.lifecycleToken) {
        return;
      }

      const message = normalizeErrorMessage(error);
      this.callbacks.onError(message);
      this.callbacks.onResponseDone({
        responseId: options.responseId,
        itemId: options.itemId,
        failedMessage: message,
      });
    }
  }
}

export class RealtimeTranslatorClient implements TranslatorClient {
  private activeProvider: RealtimeProvider | null = null;
  private transport: TranslatorClient | null = null;

  constructor(private readonly callbacks: RealtimeClientCallbacks) {}

  async connect(options: ClientConnectOptions) {
    const transport = this.ensureTransport(options.settings.provider);
    await transport.connect(options);
  }

  disconnect() {
    this.transport?.disconnect();
    this.transport = null;
    this.activeProvider = null;
  }

  updateSettings(settings: TranslatorSettings) {
    if (this.activeProvider && settings.provider !== this.activeProvider) {
      this.disconnect();
      this.callbacks.onError("Provider changed. Start listening again to switch backends.");
      return;
    }

    this.ensureTransport(settings.provider).updateSettings(settings);
  }

  requestTranslation(
    itemId: string,
    settings: TranslatorSettings,
    options?: TranslationRequestOptions,
  ) {
    this.ensureTransport(settings.provider).requestTranslation(itemId, settings, options);
  }

  setInputMuted(muted: boolean) {
    this.transport?.setInputMuted(muted);
  }

  private ensureTransport(provider: RealtimeProvider) {
    if (this.transport && this.activeProvider === provider) {
      return this.transport;
    }

    if (this.transport) {
      this.transport.disconnect();
    }

    this.activeProvider = provider;
    this.transport =
      provider === "gemini"
        ? new GeminiRealtimeTranslatorClient(this.callbacks)
        : new OpenAIRealtimeTranslatorClient(this.callbacks);

    return this.transport;
  }
}

export function createRealtimeTranslatorClient(callbacks: RealtimeClientCallbacks) {
  return new RealtimeTranslatorClient(callbacks);
}

