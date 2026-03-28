import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TranslatorApp } from "@/components/translator-app";
import type { RealtimeClientCallbacks, TranslatorClient } from "@/lib/realtime-client";
import type { RealtimeProvider } from "@/lib/realtime-config";

type MockSpeechSynthesisUtteranceType = {
  lang: string;
  pitch: number;
  rate: number;
  text: string;
  voice: SpeechSynthesisVoice | null;
};

class MockSpeechSynthesisUtterance {
  lang = "";
  pitch = 1;
  rate = 1;
  text: string;
  voice: SpeechSynthesisVoice | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function installSpeechSynthesisMock() {
  const cancel = vi.fn();
  const speak = vi.fn();

  vi.stubGlobal("speechSynthesis", {
    cancel,
    getVoices: vi.fn(() => [
      { default: true, lang: "en-US", localService: false, name: "English Voice" } as SpeechSynthesisVoice,
      { default: false, lang: "en-US", localService: true, name: "Google US English Natural" } as SpeechSynthesisVoice,
      { default: false, lang: "ja-JP", localService: true, name: "Japanese Voice" } as SpeechSynthesisVoice,
      { default: false, lang: "ko-KR", localService: true, name: "Korean Voice" } as SpeechSynthesisVoice,
      { default: false, lang: "zh-CN", localService: true, name: "Chinese Voice" } as SpeechSynthesisVoice,
    ]),
    speak,
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    MockSpeechSynthesisUtterance as unknown as typeof SpeechSynthesisUtterance,
  );

  return { cancel, speak };
}

function installAudioPlaybackMocks(response: Response | Promise<Response> = new Response(new Blob(["fake-wav"], { type: "audio/wav" }), {
  status: 200,
  headers: {
    "Content-Type": "audio/wav",
  },
})) {
  const createObjectURL = vi.fn(() => "blob:tts-audio");
  const revokeObjectURL = vi.fn();
  const playMock = vi.fn().mockResolvedValue(undefined);
  const pauseMock = vi.fn();
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response));

  class MockAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    preload = "";
    src: string;
    pause = pauseMock;
    play = playMock;

    constructor(src: string) {
      this.src = src;
    }
  }

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", MockAudio as unknown as typeof Audio);
  vi.stubGlobal("URL", {
    createObjectURL,
    revokeObjectURL,
  });

  return {
    createObjectURL,
    fetchMock,
    pauseMock,
    playMock,
    revokeObjectURL,
  };
}

function renderTranslatorApp(
  provider: RealtimeProvider = "openai",
  options?: { speechStartTimeoutMs?: number },
) {
  let callbacks!: RealtimeClientCallbacks;

  const client: TranslatorClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    updateSettings: vi.fn(),
    requestTranslation: vi.fn(),
  };

  const clientFactory = vi.fn((receivedCallbacks: RealtimeClientCallbacks) => {
    callbacks = receivedCallbacks;
    return client;
  });

  const providerResolver = vi.fn().mockResolvedValue(provider);

  render(
    <TranslatorApp
      clientFactory={clientFactory}
      providerResolver={providerResolver}
      speechStartTimeoutMs={options?.speechStartTimeoutMs}
    />,
  );

  return {
    user: userEvent.setup(),
    client,
    callbacks,
    clientFactory,
    providerResolver,
  };
}

describe("TranslatorApp", () => {
  it("detects the backend and updates settings when the source mode changes", async () => {
    const { user, client, providerResolver } = renderTranslatorApp("gemini");

    const sourceMode = screen.getByLabelText("Source mode");
    const manualSourceLanguage = screen.getByLabelText("Manual source language");
    const speechToggle = screen.getByRole("checkbox", { name: "Speak translation aloud" });

    expect(manualSourceLanguage).toBeDisabled();
    expect(speechToggle).toBeChecked();

    await waitFor(() => {
      expect(providerResolver).toHaveBeenCalledTimes(1);
      expect(client.updateSettings).toHaveBeenCalledWith({
        provider: "gemini",
        targetLanguage: "en",
        sourceLanguageMode: "auto",
        sourceLanguage: "en",
      });
    });

    await user.selectOptions(sourceMode, "manual");
    await user.selectOptions(manualSourceLanguage, "ja");

    expect(manualSourceLanguage).toBeEnabled();
    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenLastCalledWith({
        provider: "gemini",
        targetLanguage: "en",
        sourceLanguageMode: "manual",
        sourceLanguage: "ja",
      });
    });

    expect(await screen.findByText(/Backend: Gemini/)).toBeInTheDocument();
  });

  it("plays provider TTS audio when translated text is completed", async () => {
    const { cancel, speak } = installSpeechSynthesisMock();
    const { createObjectURL, fetchMock, playMock } = installAudioPlaybackMocks();
    const { user, client, callbacks } = renderTranslatorApp("openai");

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: "Start listening" }));

    expect(client.connect).toHaveBeenCalledWith({
      settings: {
        provider: "openai",
        targetLanguage: "en",
        sourceLanguageMode: "auto",
        sourceLanguage: "en",
      },
    });

    act(() => {
      callbacks.onConnectionStatus("connected");
      callbacks.onTurnCommitted({
        itemId: "turn-1",
        previousItemId: null,
        sourceLanguage: "en",
      });
      callbacks.onTranscriptCompleted({
        itemId: "turn-1",
        transcript: "Hello there",
      });
    });

    await waitFor(() => {
      expect(client.requestTranslation).toHaveBeenCalledWith("turn-1", {
        provider: "openai",
        targetLanguage: "en",
        sourceLanguageMode: "auto",
        sourceLanguage: "en",
      });
    });

    act(() => {
      callbacks.onResponseCreated({
        responseId: "response-1",
        itemId: "turn-1",
      });
      callbacks.onTranslationOutputDone({
        responseId: "response-1",
        itemId: "turn-1",
        text: "Hello",
      });
      callbacks.onResponseDone({
        responseId: "response-1",
        itemId: "turn-1",
      });
    });

    expect(await screen.findByText("Hello there")).toBeInTheDocument();
    expect(await screen.findByText("Hello")).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(playMock).toHaveBeenCalledTimes(1);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/realtime/speak",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      provider: "openai",
      targetLanguage: "en",
      text: "Hello",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(speak).not.toHaveBeenCalled();

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    await user.click(screen.getByRole("button", { name: "Copy transcript" }));

    expect(writeText).toHaveBeenCalledWith("Hello there");
    expect(await screen.findByText("Transcript copied.")).toBeInTheDocument();
  });

  it("falls back to browser speech when provider TTS start is too slow", async () => {
    const { cancel, speak } = installSpeechSynthesisMock();
    let resolveResponse!: (value: Response) => void;
    const delayedResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const { fetchMock, playMock } = installAudioPlaybackMocks(delayedResponse);
    const { callbacks, client } = renderTranslatorApp("openai", {
      speechStartTimeoutMs: 10,
    });

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalled();
    });

    act(() => {
      callbacks.onTranslationOutputDone({
        responseId: "response-slow",
        itemId: "turn-slow",
        text: "Please start talking right away",
      });
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(speak).toHaveBeenCalledTimes(1);
    });

    expect(playMock).not.toHaveBeenCalled();
    const utterance = speak.mock.calls[0][0] as MockSpeechSynthesisUtteranceType;
    expect(utterance.text).toBe("Please start talking right away");
    expect(utterance.lang).toBe("en-US");
    expect(cancel).toHaveBeenCalled();

    resolveResponse(
      new Response(new Blob(["late-audio"], { type: "audio/wav" }), {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
        },
      }),
    );
    await Promise.resolve();
  });

  it("falls back to browser speech when provider TTS fails", async () => {
    const { cancel, speak } = installSpeechSynthesisMock();
    const { fetchMock, playMock } = installAudioPlaybackMocks(
      new Response(JSON.stringify({ error: "TTS unavailable" }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
    const { callbacks, client } = renderTranslatorApp("openai");

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalled();
    });

    act(() => {
      callbacks.onTranslationOutputDone({
        responseId: "response-2",
        itemId: "turn-2",
        text: "Hello again",
      });
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(speak).toHaveBeenCalledTimes(1);
    });

    expect(playMock).not.toHaveBeenCalled();
    const utterance = speak.mock.calls[0][0] as MockSpeechSynthesisUtteranceType;
    expect(utterance.text).toBe("Hello again");
    expect(utterance.lang).toBe("en-US");
    expect(utterance.rate).toBe(0.96);
    expect(utterance.voice?.name).toBe("Google US English Natural");
    expect(cancel).toHaveBeenCalled();
  });

  it("does not speak when the speech toggle is disabled", async () => {
    const { speak } = installSpeechSynthesisMock();
    const { fetchMock, playMock } = installAudioPlaybackMocks();
    const { user, callbacks, client } = renderTranslatorApp("openai");

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("checkbox", { name: "Speak translation aloud" }));

    act(() => {
      callbacks.onTranslationOutputDone({
        responseId: "response-3",
        itemId: "turn-3",
        text: "Konnichiwa",
      });
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });
});
