import {
  buildRealtimeSessionConfig,
  buildTranslatorInstructions,
  type RealtimeSessionConfig,
  type TranslatorSettings,
} from "@/lib/realtime-config";
import type { ConnectionStatus } from "@/lib/realtime-store";

type SessionResponse = {
  ephemeralKey: string;
  model: string;
  transcriptionModel: string;
  sessionConfig: RealtimeSessionConfig;
};

export type ClientConnectOptions = {
  settings: TranslatorSettings;
};

export type RealtimeClientCallbacks = {
  onConnectionStatus: (status: ConnectionStatus) => void;
  onError: (message: string) => void;
  onRateLimit: (message: string | null) => void;
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
  requestTranslation(itemId: string, settings: TranslatorSettings): void;
}

type RealtimeServerEvent = {
  type: string;
  [key: string]: unknown;
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

  return "The Realtime API returned an unexpected error.";
}

function formatRateLimitMessage(rateLimits: unknown) {
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

  if (!primary?.name) {
    return null;
  }

  const remaining =
    typeof primary.remaining === "number" ? primary.remaining : "unknown";
  const resetSeconds =
    typeof primary.reset_seconds === "number"
      ? `${Math.ceil(primary.reset_seconds)}s`
      : "shortly";

  return `${primary.name} remaining: ${remaining}. Resets in ${resetSeconds}.`;
}

function getStringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

async function readErrorResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return `${response.status} ${response.statusText}`;
  }

  try {
    const payload = JSON.parse(text) as { error?: { message?: string } };
    return payload.error?.message ?? text;
  } catch {
    return text;
  }
}

export class RealtimeTranslatorClient implements TranslatorClient {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private mediaStream: MediaStream | null = null;
  private sessionConfig: RealtimeSessionConfig | null = null;
  private settings: TranslatorSettings | null = null;
  private pendingTranslationTurnId: string | null = null;

  constructor(private readonly callbacks: RealtimeClientCallbacks) {}

  async connect({ settings }: ClientConnectOptions) {
    this.disconnect();
    this.settings = settings;

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

    this.callbacks.onConnectionStatus("connecting");

    const sessionResponse = await this.createSession(settings);
    this.sessionConfig = sessionResponse.sessionConfig;

    const peerConnection = new RTCPeerConnection();
    this.peerConnection = peerConnection;

    this.mediaStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, this.mediaStream as MediaStream);
    });

    peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection) {
        return;
      }

      const state = this.peerConnection.connectionState;
      if (state === "connected") {
        this.callbacks.onConnectionStatus("connected");
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
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
        Authorization: `Bearer ${sessionResponse.ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!response.ok) {
      const message = await readErrorResponse(response);
      this.callbacks.onConnectionStatus("error");
      throw new Error(`Realtime connection failed: ${message}`);
    }

    const answer = await response.text();
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answer,
    });
  }

  disconnect() {
    this.pendingTranslationTurnId = null;

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

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

  requestTranslation(itemId: string, settings: TranslatorSettings) {
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
        output_modalities: ["text"],
        metadata: {
          turn_item_id: itemId,
          target_language: settings.targetLanguage,
        },
        instructions: buildTranslatorInstructions(settings),
      },
    });
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

    if (!response.ok || !payload || !("ephemeralKey" in payload)) {
      const message =
        payload && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Could not create an ephemeral Realtime session.";
      throw new Error(message);
    }

    return payload;
  }

  private handleServerEvent(rawEvent: string) {
    let event: RealtimeServerEvent;

    try {
      event = JSON.parse(rawEvent) as RealtimeServerEvent;
    } catch {
      this.callbacks.onError("Received a malformed event from the Realtime API.");
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
        this.pendingTranslationTurnId = null;
        break;
      }
      case "rate_limits.updated":
        this.callbacks.onRateLimit(formatRateLimitMessage(event.rate_limits));
        break;
      case "error":
        this.callbacks.onError(normalizeErrorMessage(event.error));
        break;
      default:
        break;
    }
  }

  private sendEvent(event: Record<string, unknown>) {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("Realtime data channel is not ready yet.");
    }

    this.dataChannel.send(JSON.stringify(event));
  }
}

export function createRealtimeTranslatorClient(callbacks: RealtimeClientCallbacks) {
  return new RealtimeTranslatorClient(callbacks);
}
