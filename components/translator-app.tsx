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

const SERVER_TTS_START_TIMEOUT_MS = 250;

function getConnectionLabel(status: ConnectionStatus) {
  switch (status) {
    case "requesting-permission":
      return "Requesting microphone";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "error":
      return "Needs attention";
    default:
      return "Idle";
  }
}

function getConnectionTone(status: ConnectionStatus) {
  switch (status) {
    case "connected":
      return "good";
    case "error":
      return "danger";
    case "connecting":
    case "requesting-permission":
      return "warn";
    default:
      return "muted";
  }
}

function getProviderLabel(provider: RealtimeProvider | null) {
  if (provider === "gemini") {
    return "Gemini";
  }

  if (provider === "openai") {
    return "OpenAI";
  }

  return "Detecting";
}

function getTurnStatusLabel(turn: TranslationTurn) {
  switch (turn.status) {
    case "transcribing":
      return "Listening";
    case "queued":
      return "Queued";
    case "translating":
      return "Translating";
    case "error":
      return "Error";
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

function speakTranslation(text: string, targetLanguage: string) {
  const spokenText = text.trim();
  if (!spokenText || !canUseBrowserSpeechSynthesis()) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(spokenText);
  const locale = getSpeechLocale(targetLanguage);
  utterance.lang = locale;
  utterance.rate = 0.96;
  utterance.pitch = 1;

  const matchingVoice = selectPreferredSpeechVoice(
    window.speechSynthesis.getVoices(),
    locale,
    targetLanguage,
  );

  if (matchingVoice) {
    utterance.voice = matchingVoice;
  }

  stopBrowserSpeechSynthesis();
  window.speechSynthesis.speak(utterance);
}

function describeError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong while talking to the selected realtime provider.";
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
  }

  useEffect(() => {
    if (!enableSpeech) {
      stopActiveSpeech();
    }
  }, [enableSpeech]);

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
      speakTranslation(spokenText, activeTargetLanguage);
      return;
    }

    const requestId = speechRequestRef.current + 1;
    speechRequestRef.current = requestId;
    speechAbortControllerRef.current?.abort();
    releaseActiveAudio();
    stopBrowserSpeechSynthesis();

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
      speakTranslation(spokenText, activeTargetLanguage);
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
      };

      audio.onended = clearCurrentAudio;
      audio.onerror = clearCurrentAudio;
      audioRef.current = audio;
      audioUrlRef.current = audioUrl;

      await audio.play();
    } catch (error) {
      settleTimeout();
      if (isAbortError(error) || requestId !== speechRequestRef.current) {
        return;
      }

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
  const isConnected = state.connectionStatus === "connected";

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
  }, [nextQueuedTurnId, provider, targetLanguage, sourceLanguageMode, sourceLanguage, state.connectionStatus]);

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
    return () => {
      stopActiveSpeech();
      clientRef.current?.disconnect();
    };
  }, []);

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
        <h1>Transcribe the source voice and translate it live in one session.</h1>
        <p className="hero-copy">
          The app automatically uses whichever realtime provider is configured on the
          server, keeps the API keys off the client, and lets you reset the session instantly.
        </p>
      </section>

      <section className="control-card">
        <div className="control-grid">
          <label className="field">
            <span>Target language</span>
            <select
              aria-label="Target language"
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

          <label className="field">
            <span>Source mode</span>
            <select
              aria-label="Source mode"
              value={sourceLanguageMode}
              onChange={(event) =>
                setSourceLanguageMode(event.target.value as SourceLanguageMode)
              }
            >
              <option value="auto">Auto detect</option>
              <option value="manual">Manual override</option>
            </select>
          </label>

          <label className="field">
            <span>Manual source language</span>
            <select
              aria-label="Manual source language"
              disabled={sourceLanguageMode !== "manual"}
              value={sourceLanguage}
              onChange={(event) => setSourceLanguage(event.target.value)}
            >
              {LANGUAGE_OPTIONS.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="status-note">
          <input
            checked={enableSpeech}
            onChange={(event) => setEnableSpeech(event.target.checked)}
            type="checkbox"
          />{" "}
          Speak translation aloud
        </label>

        <div className="button-row">
          {!isConnected ? (
            <button className="primary-button" disabled={!settings} onClick={handleStart} type="button">
              Start listening
            </button>
          ) : (
            <button className="danger-button" onClick={handleStop} type="button">
              Stop session
            </button>
          )}

          <button className="secondary-button" onClick={handleResetSession} type="button">
            Reset session
          </button>
          <button className="secondary-button" onClick={handleClearTurns} type="button">
            Clear turns
          </button>
        </div>

        <div className="status-row">
          <span className={`status-pill status-pill-${getConnectionTone(state.connectionStatus)}`}>
            {getConnectionLabel(state.connectionStatus)}
          </span>
          <span className="status-note">
            Backend: {getProviderLabel(provider)}
            {" | "}
            Target: {getLanguageLabel(targetLanguage)}
            {" | "}
            Source: {sourceLanguageMode === "manual" ? getLanguageLabel(sourceLanguage) : "Auto detect"}
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
        <article className="pane-card">
          <div className="pane-header">
            <div>
              <p className="pane-kicker">Source transcript</p>
              <h2>What the speaker said</h2>
            </div>
            <button
              className="text-button"
              onClick={() => handleCopy("transcript")}
              type="button"
            >
              Copy transcript
            </button>
          </div>

          {turns.length === 0 ? (
            <div className="empty-state">
              <p>Start a session and speak into the microphone to populate live turns.</p>
            </div>
          ) : (
            <div className="turn-list">
              {turns.map((turn) => (
                <article className="turn-card" key={`transcript-${turn.itemId}`}>
                  <header className="turn-meta">
                    <span>{turn.sourceLanguage ? getLanguageLabel(turn.sourceLanguage) : "Auto"}</span>
                    <span>{getTurnStatusLabel(turn)}</span>
                  </header>
                  <p className="turn-body">
                    {getTurnBodyText(turn, "transcript") || "Listening for speech..."}
                  </p>
                </article>
              ))}
            </div>
          )}
        </article>

        <article className="pane-card">
          <div className="pane-header">
            <div>
              <p className="pane-kicker">Translated output</p>
              <h2>What it means in {getLanguageLabel(targetLanguage)}</h2>
            </div>
            <button
              className="text-button"
              onClick={() => handleCopy("translation")}
              type="button"
            >
              Copy translation
            </button>
          </div>

          {turns.length === 0 ? (
            <div className="empty-state">
              <p>The translated pane fills as each completed source turn is processed.</p>
            </div>
          ) : (
            <div className="turn-list">
              {turns.map((turn) => (
                <article className="turn-card" key={`translation-${turn.itemId}`}>
                  <header className="turn-meta">
                    <span>Turn {turn.itemId.slice(-4).toUpperCase()}</span>
                    <span>{getTurnStatusLabel(turn)}</span>
                  </header>
                  <p className="turn-body">
                    {getTurnBodyText(turn, "translation") ||
                      (turn.status === "error"
                        ? turn.error || "Translation failed."
                        : "Waiting for translated text...")}
                  </p>
                </article>
              ))}
            </div>
          )}
        </article>
      </section>
    </main>
  );
}



