import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function installAudioPlaybackMocks(
  response: Response | Promise<Response> = new Response(new Blob(["fake-wav"], { type: "audio/wav" }), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
    },
  }),
) {
  const createObjectURL = vi.fn(() => "blob:tts-audio");
  const revokeObjectURL = vi.fn();
  const playMock = vi.fn().mockResolvedValue(undefined);
  const pauseMock = vi.fn();
  const fetchMock = vi.fn().mockImplementation(() => {
    if (typeof (response as Promise<Response>)?.then === "function") {
      return Promise.resolve(response);
    }

    return Promise.resolve((response as Response).clone());
  });

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

function installClipboardMock() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText,
    },
  });

  return { writeText };
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
    setInputMuted: vi.fn(),
  };

  const clientFactory = vi.fn((receivedCallbacks: RealtimeClientCallbacks) => {
    callbacks = receivedCallbacks;
    return client;
  });

  const providerResolver = vi.fn().mockResolvedValue(provider);
  const view = render(
    <TranslatorApp
      clientFactory={clientFactory}
      providerResolver={providerResolver}
      speechStartTimeoutMs={options?.speechStartTimeoutMs}
    />,
  );

  return {
    ...view,
    user: userEvent.setup(),
    client,
    callbacks,
    clientFactory,
    providerResolver,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TranslatorApp", () => {
  it("renders the updated hero copy and empty conversation placeholder", async () => {
    const { client } = renderTranslatorApp("gemini");

    expect(
      screen.getByRole("heading", {
        name: "Talk in your language. See and hear translations instantly.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Start speaking and get realtime transcription and translation in one place.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Try saying something like: Hello, how are you?"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Backend:/)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalledWith({
        provider: "gemini",
        targetLanguage: "en",
        sourceLanguageMode: "auto",
        sourceLanguage: "en",
      });
    });
  });

  it("keeps auto/manual source language logic inside the new From and To layout", async () => {
    const { user, client, providerResolver } = renderTranslatorApp("gemini");

    const fromMode = screen.getByLabelText("From mode");
    const manualSourceLanguage = screen.getByLabelText("Manual source language");
    const targetLanguage = screen.getByLabelText("To language");
    const speechToggle = screen.getByRole("checkbox", {
      name: "Automatically play translated speech",
    });

    expect(manualSourceLanguage).toBeDisabled();
    expect(speechToggle).toBeChecked();
    expect(screen.getByRole("button", { name: "Start interpreting" })).toBeInTheDocument();

    await waitFor(() => {
      expect(providerResolver).toHaveBeenCalledTimes(1);
      expect(client.updateSettings).toHaveBeenCalledWith({
        provider: "gemini",
        targetLanguage: "en",
        sourceLanguageMode: "auto",
        sourceLanguage: "en",
      });
    });

    await user.selectOptions(fromMode, "manual");
    expect(manualSourceLanguage).toBeEnabled();

    await user.selectOptions(manualSourceLanguage, "ja");
    await user.selectOptions(targetLanguage, "ko");

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenLastCalledWith({
        provider: "gemini",
        targetLanguage: "ko",
        sourceLanguageMode: "manual",
        sourceLanguage: "ja",
      });
    });

    expect(screen.getByText("From: Japanese | To: Korean")).toBeInTheDocument();
  });

  it("shows live mic level feedback, mutes input during playback, and supports replay", async () => {
    const { cancel, speak } = installSpeechSynthesisMock();
    const { createObjectURL, fetchMock, playMock } = installAudioPlaybackMocks();
    const { user, client, callbacks, container } = renderTranslatorApp("openai");
    const { writeText } = installClipboardMock();

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: "Start interpreting" }));

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
      callbacks.onInputLevel(0.62);
      callbacks.onTurnCommitted({
        itemId: "turn-1",
        previousItemId: null,
        sourceLanguage: "ko",
      });
      callbacks.onTranscriptCompleted({
        itemId: "turn-1",
        transcript: "Annyeonghaseyo",
      });
    });

    expect(screen.getByRole("button", { name: "Listening..." })).toBeInTheDocument();
    expect(container.querySelector(".waveform")).not.toBeNull();
    expect(screen.getByText("Voice detected.")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Microphone input level" }),
    ).toHaveAttribute("aria-valuenow", "62");

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

    expect(await screen.findByText("Annyeonghaseyo")).toBeInTheDocument();
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "You said" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Translation" })).toBeInTheDocument();
    expect(screen.getByText("Turn 01")).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(playMock).toHaveBeenCalledTimes(1);
      expect(client.setInputMuted).toHaveBeenCalledWith(true);
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
    expect(speak).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Replay translation for turn 1" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(playMock).toHaveBeenCalledTimes(2);
    });

    expect(cancel).toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      provider: "openai",
      targetLanguage: "en",
      text: "Hello",
    });

    await user.click(screen.getByRole("button", { name: "Copy transcript" }));
    expect(writeText).toHaveBeenCalledWith("Annyeonghaseyo");
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
      expect(client.setInputMuted).toHaveBeenCalledWith(true);
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

  it("skips browser speech fallback for Korean and surfaces the speech error instead", async () => {
    const { speak } = installSpeechSynthesisMock();
    const { fetchMock, playMock } = installAudioPlaybackMocks(
      new Response(JSON.stringify({ error: "TTS quota exceeded." }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );
    const { user, callbacks, client } = renderTranslatorApp("openai");

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalled();
    });

    await user.selectOptions(screen.getByLabelText("To language"), "ko");

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenLastCalledWith({
        provider: "openai",
        targetLanguage: "ko",
        sourceLanguageMode: "auto",
        sourceLanguage: "en",
      });
    });

    act(() => {
      callbacks.onTranslationOutputDone({
        responseId: "response-ko-error",
        itemId: "turn-ko-error",
        text: "Please read this naturally.",
      });
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    expect(playMock).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Korean speech playback failed, so browser fallback was skipped/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/TTS quota exceeded\./i)).toBeInTheDocument();
  });
  it("disables automatic playback and hides replay controls when speech is turned off", async () => {
    const { speak } = installSpeechSynthesisMock();
    const { fetchMock, playMock } = installAudioPlaybackMocks();
    const { user, callbacks, client } = renderTranslatorApp("openai");

    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenCalled();
    });

    await user.click(
      screen.getByRole("checkbox", { name: "Automatically play translated speech" }),
    );

    act(() => {
      callbacks.onTurnCommitted({
        itemId: "turn-2",
        previousItemId: null,
        sourceLanguage: "ko",
      });
      callbacks.onTranscriptCompleted({
        itemId: "turn-2",
        transcript: "Jigeum doenayo",
      });
      callbacks.onTranslationOutputDone({
        responseId: "response-2",
        itemId: "turn-2",
        text: "Is this working now?",
      });
      callbacks.onResponseDone({
        responseId: "response-2",
        itemId: "turn-2",
      });
    });

    expect(await screen.findByText("Is this working now?")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(playMock).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
    expect(client.setInputMuted).not.toHaveBeenCalledWith(true);
    expect(
      screen.queryByRole("button", { name: "Replay translation for turn 1" }),
    ).not.toBeInTheDocument();
  });
});

