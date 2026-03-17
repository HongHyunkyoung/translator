"use client";

import { startTransition, useEffect, useReducer, useRef, useState } from "react";
import {
  createRealtimeTranslatorClient,
  type RealtimeClientCallbacks,
  type TranslatorClient,
} from "@/lib/realtime-client";
import { DEFAULT_TARGET_LANGUAGE, LANGUAGE_OPTIONS, getLanguageLabel } from "@/lib/languages";
import {
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
};

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

function describeError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong while talking to the Realtime API.";
}

export function TranslatorApp({
  clientFactory = createRealtimeTranslatorClient,
}: TranslatorAppProps) {
  const [state, dispatch] = useReducer(translatorReducer, initialTranslatorState);
  const [targetLanguage, setTargetLanguage] = useState(DEFAULT_TARGET_LANGUAGE);
  const [sourceLanguageMode, setSourceLanguageMode] = useState<SourceLanguageMode>("auto");
  const [sourceLanguage, setSourceLanguage] = useState("ko");
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const clientRef = useRef<TranslatorClient | null>(null);

  const settings: TranslatorSettings = {
    targetLanguage,
    sourceLanguageMode,
    sourceLanguage,
  };

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
    clientRef.current?.updateSettings(settings);
  }, [targetLanguage, sourceLanguageMode, sourceLanguage]);

  useEffect(() => {
    if (state.connectionStatus !== "connected" || !nextQueuedTurnId) {
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
    state.connectionStatus,
    targetLanguage,
    sourceLanguageMode,
    sourceLanguage,
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
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  async function handleStart() {
    dispatch({ type: "error/set", message: null });
    dispatch({ type: "rate-limit/set", message: null });

    try {
      await clientRef.current?.connect({ settings });
    } catch (error) {
      clientRef.current?.disconnect();
      dispatch({ type: "connection/status", status: "error" });
      dispatch({ type: "error/set", message: describeError(error) });
    }
  }

  function handleStop() {
    clientRef.current?.disconnect();
  }

  async function handleResetSession() {
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
          WebRTC keeps the browser low-latency, an ephemeral key keeps the API key off
          the client, and the UI stays session-local so you can reset instantly.
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

        <div className="button-row">
          {!isConnected ? (
            <button className="primary-button" onClick={handleStart} type="button">
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
            Target: {getLanguageLabel(targetLanguage)}
            {" | "}
            Source:{" "}
            {sourceLanguageMode === "manual"
              ? getLanguageLabel(sourceLanguage)
              : "Auto detect"}
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
