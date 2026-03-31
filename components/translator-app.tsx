"use client";

import { startTransition, useEffect, useReducer, useRef, useState } from "react";
import {
  createRealtimeTranslatorClient,
  type RealtimeClientCallbacks,
  type TranslatorClient,
} from "@/lib/realtime-client";
import { DEFAULT_TARGET_LANGUAGE, LANGUAGE_OPTIONS, getLanguageLabel } from "@/lib/languages";
import {
  type RealtimeProvider,
  type SourceLanguageMode,
  type TranslatorSettings,
} from "@/lib/realtime-config";
import {
  getNextQueuedTurnId,
  initialTranslatorState,
  selectOrderedTurns,
  translatorReducer,
  type ConnectionStatus,
  type TranslationTurn,
} from "@/lib/realtime-store";

type TranslatorAppProps = {
  clientFactory?: (callbacks: RealtimeClientCallbacks) => TranslatorClient;
  providerResolver?: () => Promise<RealtimeProvider>;
  speechStartTimeoutMs?: number;
};

type InterpreterActivity =
  | "idle"
  | "listening"
  | "processing"
  | "translating"
  | "speaking";

type SpeechLifecycleCallbacks = {
  onEnd?: () => void;
  onStart?: () => void;
};

const MICROPHONE_ICON = "\uD83C\uDFA4";
const SPEAKER_ICON = "\uD83D\uDD0A";
const TITLE_DIVIDER = "\u2192";
const MICROPHONE_LEVEL_LABEL = "Microphone input level";
const SERVER_TTS_START_TIMEOUT_MS = 900;

async function resolveProviderFromServer(): Promise<RealtimeProvider> {
  const response = await fetch("/api/realtime/provider", {
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { provider?: unknown; error?: string }
    | null;

  if (!response.ok || !payload || (payload.provider !== "openai" && payload.provider !== "gemini")) {
    throw new Error(
      payload?.error ?? "Could not detect which realtime provider is configured on the server.",
    );
  }

  return payload.provider;
}

function getTurnStatusLabel(turn: TranslationTurn) {
  switch (turn.status) {
    case "transcribing":
      return "Listening...";
    case "queued":
      return "Processing speech...";
    case "translating":
      return "Translating...";
    case "error":
      return "Needs attention";
    default:
      return "Ready";
  }
}

function getTurnBodyText(turn: TranslationTurn, kind: "transcript" | "translation") {
  if (kind === "transcript") {
    return turn.transcriptFinal || turn.transcriptDraft;
  }

  return turn.translationFinal || turn.translationDraft;
}

function buildCopyBlock(turns: TranslationTurn[], kind: "transcript" | "translation") {
  return turns
    .map((turn) => getTurnBodyText(turn, kind).trim())
    .filter(Boolean)
    .join("\n\n");
}

function getSpeechLocale(targetLanguage: string) {
  return LANGUAGE_OPTIONS.find((language) => language.code === targetLanguage)?.locale ?? "en-US";
}

function getSourceSummary(sourceLanguageMode: SourceLanguageMode, sourceLanguage: string) {
  return sourceLanguageMode === "manual" ? getLanguageLabel(sourceLanguage) : "Auto detect";
}

function clampLevel(level: number) {
  return Math.max(0, Math.min(1, level));
}

function getWaveformHeights(inputLevel: number, isSpeaking: boolean) {
  const baseLevel = isSpeaking ? 0 : clampLevel(inputLevel);
  const multipliers = [0.38, 0.62, 0.96, 0.84, 0.58, 0.32];

  return multipliers.map((factor) => 12 + Math.round(baseLevel * factor * 28));
}

function getMicrophoneFeedbackText(inputLevel: number, isSpeaking: boolean) {
  if (isSpeaking) {
    return "Microphone pauses while translated speech plays.";
  }

  return inputLevel >= 0.12 ? "Voice detected." : "Waiting for your voice.";
}

async function readSpeechErrorResponse(response: Response) {
  const text = await response.text();
  if (!text) {
    return `Speech route returned ${response.status}.`;
  }

  try {
    const payload = JSON.parse(text) as { error?: unknown };
    return typeof payload.error === "string" && payload.error ? payload.error : text;
  } catch {
    return text;
  }
}

function canUseBrowserSpeechSynthesis() {
  return (
    typeof window !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined" &&
    "speechSynthesis" in window
  );
}

function stopBrowserSpeechSynthesis() {
  if (canUseBrowserSpeechSynthesis()) {
    window.speechSynthesis.cancel();
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function getVoicePreferenceScore(
  voice: SpeechSynthesisVoice,
  locale: string,
  targetLanguage: string,
) {
  const normalizedVoiceLanguage = voice.lang.toLowerCase();
  const normalizedLocale = locale.toLowerCase();
  const normalizedTargetLanguage = targetLanguage.toLowerCase();
  const normalizedName = voice.name.toLowerCase();

  let score = 0;

  if (normalizedVoiceLanguage === normalizedLocale) {
    score += 8;
  } else if (normalizedVoiceLanguage.startsWith(normalizedTargetLanguage + "-")) {
    score += 5;
  }

  if (voice.localService) {
    score += 3;
  }

  if (/(natural|neural|premium|enhanced|wavenet|studio|siri)/i.test(normalizedName)) {
    score += 4;
  }

  if (/(google|microsoft|apple)/i.test(normalizedName)) {
    score += 2;
  }

  if (voice.default) {
    score += 1;
  }

  return score;
}

function selectPreferredSpeechVoice(
  voices: SpeechSynthesisVoice[],
  locale: string,
  targetLanguage: string,
) {
  const rankedVoices = voices
    .filter((voice) => {
      const normalizedVoiceLanguage = voice.lang.toLowerCase();
      const normalizedLocale = locale.toLowerCase();
      const normalizedTargetLanguage = targetLanguage.toLowerCase();

      return (
        normalizedVoiceLanguage === normalizedLocale ||
        normalizedVoiceLanguage.startsWith(normalizedTargetLanguage + "-")
      );
    })
    .sort(
      (left, right) =>
        getVoicePreferenceScore(right, locale, targetLanguage) -
        getVoicePreferenceScore(left, locale, targetLanguage),
    );

  return rankedVoices[0] ?? null;
}

function speakTranslation(
  text: string,
  targetLanguage: string,
  callbacks?: SpeechLifecycleCallbacks,
) {
  const spokenText = text.trim();
  if (!spokenText || !canUseBrowserSpeechSynthesis()) {
    return false;
  }

  const utterance = new SpeechSynthesisUtterance(spokenText);
  const locale = getSpeechLocale(targetLanguage);
  utterance.lang = locale;
  utterance.rate = 0.96;
  utterance.pitch = 1;
  utterance.onend = () => {
    callbacks?.onEnd?.();
  };
  utterance.onerror = () => {
    callbacks?.onEnd?.();
  };

  const matchingVoice = selectPreferredSpeechVoice(
    window.speechSynthesis.getVoices(),
    locale,
    targetLanguage,
  );

  if (matchingVoice) {
    utterance.voice = matchingVoice;
  }

  stopBrowserSpeechSynthesis();
  callbacks?.onStart?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

function describeError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong while talking to the selected realtime provider.";
}

function getInterpreterActivity(
  turns: TranslationTurn[],
  connectionStatus: ConnectionStatus,
  isSpeaking: boolean,
): InterpreterActivity {
  if (isSpeaking) {
    return "speaking";
  }

  if (turns.some((turn) => turn.status === "translating")) {
    return "translating";
  }

  if (turns.some((turn) => turn.status === "queued")) {
    return "processing";
  }

  if (
    connectionStatus === "connected" ||
    connectionStatus === "connecting" ||
    connectionStatus === "requesting-permission"
  ) {
    return "listening";
  }

  return "idle";
}

function getInterpreterActivityLabel(activity: InterpreterActivity) {
  switch (activity) {
    case "listening":
      return "Listening...";
    case "processing":
      return "Processing speech...";
    case "translating":
      return "Translating...";
    case "speaking":
      return "Speaking...";
    default:
      return "Idle";
  }
}

function getInterpreterActivityTone(
  activity: InterpreterActivity,
  connectionStatus: ConnectionStatus,
) {
  if (connectionStatus === "error") {
    return "danger";
  }

  switch (activity) {
    case "listening":
    case "speaking":
      return "good";
    case "processing":
    case "translating":
      return "warn";
    default:
      return "muted";
  }
}

export function TranslatorApp({
  clientFactory = createRealtimeTranslatorClient,
  providerResolver = resolveProviderFromServer,
  speechStartTimeoutMs = SERVER_TTS_START_TIMEOUT_MS,
}: TranslatorAppProps) {
  const [state, dispatch] = useReducer(translatorReducer, initialTranslatorState);
  const [provider, setProvider] = useState<RealtimeProvider | null>(null);
  const [targetLanguage, setTargetLanguage] = useState(DEFAULT_TARGET_LANGUAGE);
  const [sourceLanguageMode, setSourceLanguageMode] = useState<SourceLanguageMode>("auto");
  const [sourceLanguage, setSourceLanguage] = useState("en");
  const [enableSpeech, setEnableSpeech] = useState(true);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const clientRef = useRef<TranslatorClient | null>(null);
  const enableSpeechRef = useRef(enableSpeech);
  const providerRef = useRef<RealtimeProvider | null>(provider);
  const targetLanguageRef = useRef(targetLanguage);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const speechAbortControllerRef = useRef<AbortController | null>(null);
  const speechRequestRef = useRef(0);

  const settings: TranslatorSettings | null = provider
    ? {
        provider,
        targetLanguage,
        sourceLanguageMode,
        sourceLanguage,
      }
    : null;

  useEffect(() => {
    let active = true;

    void providerResolver()
      .then((resolvedProvider) => {
        if (!active) {
          return;
        }

        setProvider(resolvedProvider);
        dispatch({ type: "error/set", message: null });
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        dispatch({ type: "error/set", message: describeError(error) });
      });

    return () => {
      active = false;
    };
  }, [providerResolver]);

  useEffect(() => {
    enableSpeechRef.current = enableSpeech;
  }, [enableSpeech]);

  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  useEffect(() => {
    targetLanguageRef.current = targetLanguage;
  }, [targetLanguage]);

  function setInputMuted(muted: boolean) {
    clientRef.current?.setInputMuted(muted);
    if (muted) {
      setInputLevel(0);
    }
  }

  function releaseActiveAudio() {
    const activeAudio = audioRef.current;
    if (activeAudio) {
      activeAudio.onended = null;
      activeAudio.onerror = null;
      activeAudio.pause();
      audioRef.current = null;
    }

    if (audioUrlRef.current) {
      if (typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      audioUrlRef.current = null;
    }
  }

  function stopActiveSpeech() {
    speechRequestRef.current += 1;
    speechAbortControllerRef.current?.abort();
    speechAbortControllerRef.current = null;
    releaseActiveAudio();
    stopBrowserSpeechSynthesis();
    setInputMuted(false);
    setIsSpeaking(false);
  }

  useEffect(() => {
    if (!enableSpeech) {
      stopActiveSpeech();
    }
  }, [enableSpeech]);

  function playBrowserTranslation(text: string, language: string) {
    setInputMuted(true);

    const started = speakTranslation(text, language, {
      onEnd: () => {
        setIsSpeaking(false);
        setInputMuted(false);
      },
      onStart: () => {
        setIsSpeaking(true);
      },
    });

    if (!started) {
      setIsSpeaking(false);
      setInputMuted(false);
    }
  }

  function handleReplayTranslation(text: string) {
    if (!text.trim()) {
      return;
    }

    stopActiveSpeech();
    playBrowserTranslation(text, targetLanguageRef.current);
  }

  async function playTranslationAudio(text: string) {
    const spokenText = text.trim();
    if (!spokenText || !enableSpeechRef.current) {
      return;
    }

    const activeProvider = providerRef.current;
    const activeTargetLanguage = targetLanguageRef.current;

    if (
      !activeProvider ||
      typeof window === "undefined" ||
      typeof Audio === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      playBrowserTranslation(spokenText, activeTargetLanguage);
      return;
    }

    const requestId = speechRequestRef.current + 1;
    speechRequestRef.current = requestId;
    speechAbortControllerRef.current?.abort();
    releaseActiveAudio();
    stopBrowserSpeechSynthesis();
    setIsSpeaking(false);

    const abortController = typeof AbortController !== "undefined" ? new AbortController() : null;
    speechAbortControllerRef.current = abortController;

    let timeoutId: number | null = null;
    const requestPromise = fetch("/api/realtime/speak", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: activeProvider,
        targetLanguage: activeTargetLanguage,
        text: spokenText,
      }),
      signal: abortController?.signal,
    })
      .then((response) => ({ kind: "response" as const, response }))
      .catch((error: unknown) => ({ kind: "error" as const, error }));

    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutId = window.setTimeout(() => {
        resolve({ kind: "timeout" });
      }, speechStartTimeoutMs);
    });

    const settleTimeout = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const fallbackToBrowserSpeech = () => {
      abortController?.abort();
      if (speechAbortControllerRef.current === abortController) {
        speechAbortControllerRef.current = null;
      }
      if (requestId !== speechRequestRef.current) {
        return;
      }
      releaseActiveAudio();
      setIsSpeaking(false);
      playBrowserTranslation(spokenText, activeTargetLanguage);
    };

    try {
      const outcome = await Promise.race([requestPromise, timeoutPromise]);
      settleTimeout();

      if (outcome.kind === "timeout") {
        fallbackToBrowserSpeech();
        return;
      }

      if (outcome.kind === "error") {
        if (isAbortError(outcome.error)) {
          return;
        }
        fallbackToBrowserSpeech();
        return;
      }

      if (!outcome.response.ok) {
        void readSpeechErrorResponse(outcome.response);
        fallbackToBrowserSpeech();
        return;
      }

      const audioUrl = URL.createObjectURL(await outcome.response.blob());

      if (speechAbortControllerRef.current === abortController) {
        speechAbortControllerRef.current = null;
      }

      if (requestId !== speechRequestRef.current) {
        abortController?.abort();
        if (typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(audioUrl);
        }
        return;
      }

      const audio = new Audio(audioUrl);
      audio.preload = "auto";

      const clearCurrentAudio = () => {
        if (audioRef.current === audio) {
          audioRef.current = null;
        }

        if (audioUrlRef.current === audioUrl) {
          if (typeof URL.revokeObjectURL === "function") {
            URL.revokeObjectURL(audioUrl);
          }
          audioUrlRef.current = null;
        }

        setInputMuted(false);
        setIsSpeaking(false);
      };

      audio.onended = clearCurrentAudio;
      audio.onerror = clearCurrentAudio;
      audioRef.current = audio;
      audioUrlRef.current = audioUrl;
      setInputMuted(true);
      setIsSpeaking(true);

      await audio.play();
    } catch (error) {
      settleTimeout();
      if (isAbortError(error) || requestId !== speechRequestRef.current) {
        return;
      }

      setIsSpeaking(false);
      fallbackToBrowserSpeech();
    }
  }

  if (!clientRef.current) {
    clientRef.current = clientFactory({
      onConnectionStatus(status) {
        startTransition(() => {
          dispatch({ type: "connection/status", status });
        });
      },
      onError(message) {
        startTransition(() => {
          dispatch({ type: "error/set", message });
        });
      },
      onRateLimit(message) {
        startTransition(() => {
          dispatch({ type: "rate-limit/set", message });
        });
      },
      onInputLevel(level) {
        setInputLevel(clampLevel(level));
      },
      onTurnCommitted(payload) {
        startTransition(() => {
          dispatch({
            type: "turn/committed",
            itemId: payload.itemId,
            previousItemId: payload.previousItemId,
            sourceLanguage: payload.sourceLanguage,
          });
        });
      },
      onTranscriptDelta(payload) {
        startTransition(() => {
          dispatch({
            type: "turn/transcriptDelta",
            itemId: payload.itemId,
            delta: payload.delta,
          });
        });
      },
      onTranscriptCompleted(payload) {
        startTransition(() => {
          dispatch({
            type: "turn/transcriptCompleted",
            itemId: payload.itemId,
            transcript: payload.transcript,
          });
        });
      },
      onResponseCreated(payload) {
        startTransition(() => {
          dispatch({
            type: "translation/responseCreated",
            responseId: payload.responseId,
            itemId: payload.itemId,
          });
        });
      },
      onTranslationDelta(payload) {
        startTransition(() => {
          dispatch({
            type: "translation/delta",
            responseId: payload.responseId,
            itemId: payload.itemId,
            delta: payload.delta,
          });
        });
      },
      onTranslationOutputDone(payload) {
        startTransition(() => {
          dispatch({
            type: "translation/outputDone",
            responseId: payload.responseId,
            itemId: payload.itemId,
            text: payload.text,
          });
        });

        if (enableSpeechRef.current) {
          void playTranslationAudio(payload.text);
        }
      },
      onResponseDone(payload) {
        startTransition(() => {
          dispatch({
            type: "translation/responseDone",
            responseId: payload.responseId,
            itemId: payload.itemId,
            failedMessage: payload.failedMessage,
          });
        });
      },
    });
  }

  const turns = selectOrderedTurns(state);
  const nextQueuedTurnId = getNextQueuedTurnId(state);
  const isSessionActive =
    state.connectionStatus === "connected" ||
    state.connectionStatus === "connecting" ||
    state.connectionStatus === "requesting-permission";
  const interpreterActivity = getInterpreterActivity(
    turns,
    state.connectionStatus,
    isSpeaking,
  );
  const sourceSummary = getSourceSummary(sourceLanguageMode, sourceLanguage);
  const sourceLanguageDisabled = sourceLanguageMode !== "manual";
  const normalizedInputLevel = clampLevel(inputLevel);
  const inputLevelPercent = isSpeaking ? 0 : Math.round(normalizedInputLevel * 100);
  const inputMeterWidth = isSpeaking ? 0 : Math.max(isSessionActive ? 6 : 0, inputLevelPercent);
  const waveformHeights = getWaveformHeights(normalizedInputLevel, isSpeaking);
  const microphoneFeedbackText = getMicrophoneFeedbackText(normalizedInputLevel, isSpeaking);

  useEffect(() => {
    if (!provider) {
      return;
    }

    clientRef.current?.updateSettings({
      provider,
      targetLanguage,
      sourceLanguageMode,
      sourceLanguage,
    });
  }, [provider, targetLanguage, sourceLanguageMode, sourceLanguage]);

  useEffect(() => {
    if (!settings || state.connectionStatus !== "connected" || !nextQueuedTurnId) {
      return;
    }

    try {
      dispatch({ type: "translation/requested", itemId: nextQueuedTurnId });
      clientRef.current?.requestTranslation(nextQueuedTurnId, settings);
    } catch (error) {
      const message = describeError(error);
      dispatch({
        type: "translation/error",
        itemId: nextQueuedTurnId,
        message,
      });
    }
  }, [
    nextQueuedTurnId,
    provider,
    sourceLanguage,
    sourceLanguageMode,
    state.connectionStatus,
    targetLanguage,
  ]);

  useEffect(() => {
    if (!copyMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyMessage(null);
    }, 1800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [copyMessage]);

  useEffect(() => {
    if (!isSessionActive) {
      setInputLevel(0);
    }
  }, [isSessionActive]);

  useEffect(() => {
    return () => {
      stopActiveSpeech();
      clientRef.current?.disconnect();
    };
  }, []);

  function handleSourceModeChange(value: SourceLanguageMode) {
    setSourceLanguageMode(value);
  }

  async function handleStart() {
    dispatch({ type: "error/set", message: null });
    dispatch({ type: "rate-limit/set", message: null });

    if (!settings) {
      dispatch({
        type: "error/set",
        message: "No supported realtime provider is configured on the server yet.",
      });
      return;
    }

    try {
      await clientRef.current?.connect({ settings });
    } catch (error) {
      clientRef.current?.disconnect();
      dispatch({ type: "connection/status", status: "error" });
      dispatch({ type: "error/set", message: describeError(error) });
    }
  }

  function handleStop() {
    stopActiveSpeech();
    clientRef.current?.disconnect();
  }

  async function handleResetSession() {
    if (!settings) {
      dispatch({
        type: "error/set",
        message: "No supported realtime provider is configured on the server yet.",
      });
      return;
    }

    stopActiveSpeech();
    clientRef.current?.disconnect();
    dispatch({ type: "reset" });

    try {
      await clientRef.current?.connect({ settings });
    } catch (error) {
      clientRef.current?.disconnect();
      dispatch({ type: "connection/status", status: "error" });
      dispatch({ type: "error/set", message: describeError(error) });
    }
  }

  function handleClearTurns() {
    dispatch({ type: "clear-turns" });
  }

  async function handleCopy(kind: "transcript" | "translation") {
    const text = buildCopyBlock(turns, kind);
    if (!text) {
      setCopyMessage(`No ${kind} text to copy yet.`);
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage(
        kind === "transcript" ? "Transcript copied." : "Translation copied.",
      );
    } catch {
      setCopyMessage("Clipboard access failed.");
    }
  }

  return (
    <main className="page-shell">
      <div className="page-orb page-orb-left" />
      <div className="page-orb page-orb-right" />

      <section className="hero-card">
        <p className="eyebrow">Realtime speech interpreter</p>
        <h1>Talk in your language. See and hear translations instantly.</h1>
        <p className="hero-copy">
          Start speaking and get realtime transcription and translation in one place.
        </p>
      </section>

      <section className="control-card">
        <div className="language-row">
          <label className="field field-from">
            <span>From</span>
            <div className="from-control-row">
              <select
                aria-label="From mode"
                className="select-compact"
                value={sourceLanguageMode}
                onChange={(event) =>
                  handleSourceModeChange(event.target.value as SourceLanguageMode)
                }
              >
                <option value="auto">Auto detect</option>
                <option value="manual">Manual override</option>
              </select>

              <select
                aria-label="Manual source language"
                disabled={sourceLanguageDisabled}
                value={sourceLanguage}
                onChange={(event) => setSourceLanguage(event.target.value)}
              >
                {LANGUAGE_OPTIONS.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </div>
          </label>

          <label className="field field-to">
            <span>To</span>
            <select
              aria-label="To language"
              value={targetLanguage}
              onChange={(event) => setTargetLanguage(event.target.value)}
            >
              {LANGUAGE_OPTIONS.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="auto-play-toggle">
          <input
            checked={enableSpeech}
            onChange={(event) => setEnableSpeech(event.target.checked)}
            type="checkbox"
          />
          Automatically play translated speech
        </label>

        <div className="button-row">
          <button
            className={`primary-button${isSessionActive ? " primary-button-listening" : ""}`}
            disabled={!settings}
            onClick={isSessionActive ? handleStop : handleStart}
            type="button"
          >
            <span aria-hidden="true">{MICROPHONE_ICON}</span>
            <span>{isSessionActive ? "Listening..." : "Start interpreting"}</span>
          </button>

          <button className="secondary-button" onClick={handleResetSession} type="button">
            Reset session
          </button>
          <button className="secondary-button" onClick={handleClearTurns} type="button">
            Clear turns
          </button>
        </div>

        {isSessionActive ? (
          <div className="mic-feedback">
            <div className="waveform" aria-hidden="true">
              {waveformHeights.map((height, index) => (
                <span
                  className="waveform-bar"
                  key={`wave-${index + 1}`}
                  style={{
                    height: `${height}px`,
                    opacity: isSpeaking ? 0.35 : Math.max(0.4, height / 36),
                  }}
                />
              ))}
            </div>

            <div className="input-meter-row">
              <div
                aria-label={MICROPHONE_LEVEL_LABEL}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={inputLevelPercent}
                aria-valuetext={isSpeaking ? "Microphone paused during playback" : `${inputLevelPercent}%`}
                className="input-meter-track"
                role="progressbar"
              >
                <span className="input-meter-fill" style={{ width: `${inputMeterWidth}%` }} />
              </div>
              <span className="input-meter-copy">{microphoneFeedbackText}</span>
            </div>
          </div>
        ) : null}

        <div className="session-status-stack">
          <span
            aria-live="polite"
            className={`status-pill status-pill-${getInterpreterActivityTone(
              interpreterActivity,
              state.connectionStatus,
            )}`}
          >
            {getInterpreterActivityLabel(interpreterActivity)}
          </span>
          <span className="status-note">
            From: {sourceSummary} | To: {getLanguageLabel(targetLanguage)}
          </span>
          {copyMessage ? <span className="status-note">{copyMessage}</span> : null}
        </div>

        {state.errorMessage ? (
          <p className="message-banner message-banner-danger">{state.errorMessage}</p>
        ) : null}
        {state.rateLimitMessage ? (
          <p className="message-banner message-banner-warn">{state.rateLimitMessage}</p>
        ) : null}
      </section>

      <section className="pane-grid">
        <article className="pane-card conversation-panel">
          <div className="conversation-panel-header">
            <div>
              <p className="pane-kicker">Conversation history</p>
              <div className="conversation-title-row">
                <h2>You said</h2>
                <span className="conversation-title-divider">{TITLE_DIVIDER}</span>
                <h2>Translation</h2>
              </div>
            </div>

            <div className="conversation-copy-actions">
              <button
                className="text-button"
                onClick={() => handleCopy("transcript")}
                type="button"
              >
                Copy transcript
              </button>
              <button
                className="text-button"
                onClick={() => handleCopy("translation")}
                type="button"
              >
                Copy translation
              </button>
            </div>
          </div>

          {turns.length === 0 ? (
            <div className="empty-state">
              <p>Try saying something like: Hello, how are you?</p>
            </div>
          ) : (
            <div className="turn-list">
              {turns.map((turn, index) => {
                const transcriptText = getTurnBodyText(turn, "transcript") || "Listening for speech...";
                const translationText = getTurnBodyText(turn, "translation");
                const replayText = (turn.translationFinal || turn.translationDraft).trim();
                const sourceLabel = turn.sourceLanguage
                  ? getLanguageLabel(turn.sourceLanguage)
                  : sourceSummary;

                return (
                  <article className="turn-card conversation-turn-card" key={turn.itemId}>
                    <header className="conversation-turn-header">
                      <div className="conversation-turn-badges">
                        <span className="conversation-chip">
                          Turn {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="conversation-chip conversation-chip-muted">
                          {sourceLabel}
                        </span>
                      </div>

                      <div className="conversation-turn-actions">
                        <span className="conversation-status">{getTurnStatusLabel(turn)}</span>
                        {enableSpeech && replayText ? (
                          <button
                            aria-label={`Replay translation for turn ${index + 1}`}
                            className="replay-button"
                            onClick={() => handleReplayTranslation(replayText)}
                            type="button"
                          >
                            <span aria-hidden="true">{SPEAKER_ICON}</span>
                          </button>
                        ) : null}
                      </div>
                    </header>

                    <div className="conversation-turn-grid">
                      <section className="conversation-block">
                        <p className="conversation-label">You said</p>
                        <p className="conversation-text">{transcriptText}</p>
                      </section>

                      <section className="conversation-block">
                        <p className="conversation-label">Translation</p>
                        <p className="conversation-text">
                          {translationText ||
                            (turn.status === "error"
                              ? turn.error || "Translation failed."
                              : "Waiting for translated text...")}
                        </p>
                      </section>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </article>
      </section>
    </main>
  );
}

