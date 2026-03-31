export type ConnectionStatus =
  | "idle"
  | "requesting-permission"
  | "connecting"
  | "connected"
  | "error";

export type TranslationTurnStatus =
  | "transcribing"
  | "queued"
  | "translating"
  | "done"
  | "error";

export type TranslationTurn = {
  itemId: string;
  previousItemId: string | null;
  sourceLanguage: string | null;
  transcriptDraft: string;
  transcriptFinal: string;
  translationDraft: string;
  translationFinal: string;
  status: TranslationTurnStatus;
  createdAt: number;
  responseId?: string | null;
  error?: string | null;
};

export type TranslatorState = {
  turnsById: Record<string, TranslationTurn>;
  orderedTurnIds: string[];
  translationQueue: string[];
  activeTranslationItemId: string | null;
  responseTurnMap: Record<string, string>;
  connectionStatus: ConnectionStatus;
  errorMessage: string | null;
  rateLimitMessage: string | null;
};

export type TranslatorAction =
  | { type: "connection/status"; status: ConnectionStatus }
  | { type: "error/set"; message: string | null }
  | { type: "rate-limit/set"; message: string | null }
  | {
      type: "turn/committed";
      itemId: string;
      previousItemId: string | null;
      sourceLanguage: string | null;
      createdAt?: number;
    }
  | { type: "turn/transcriptDelta"; itemId: string; delta: string }
  | { type: "turn/transcriptCompleted"; itemId: string; transcript: string }
  | { type: "translation/requested"; itemId: string }
  | { type: "translation/responseCreated"; responseId: string; itemId?: string }
  | {
      type: "translation/delta";
      responseId?: string;
      itemId?: string;
      delta: string;
    }
  | {
      type: "translation/outputDone";
      responseId?: string;
      itemId?: string;
      text: string;
    }
  | {
      type: "translation/responseDone";
      responseId?: string;
      itemId?: string;
      failedMessage?: string | null;
    }
  | { type: "translation/error"; itemId: string; message: string }
  | { type: "clear-turns" }
  | { type: "reset" };

export const initialTranslatorState: TranslatorState = {
  turnsById: {},
  orderedTurnIds: [],
  translationQueue: [],
  activeTranslationItemId: null,
  responseTurnMap: {},
  connectionStatus: "idle",
  errorMessage: null,
  rateLimitMessage: null,
};

function insertOrderedTurn(
  orderedTurnIds: string[],
  itemId: string,
  previousItemId: string | null,
) {
  if (orderedTurnIds.includes(itemId)) {
    return orderedTurnIds;
  }

  if (!previousItemId || previousItemId === "root") {
    return [...orderedTurnIds, itemId];
  }

  const previousIndex = orderedTurnIds.indexOf(previousItemId);
  if (previousIndex === -1) {
    return [...orderedTurnIds, itemId];
  }

  const next = [...orderedTurnIds];
  next.splice(previousIndex + 1, 0, itemId);
  return next;
}

function pruneEmptyTurn(state: TranslatorState, itemId: string) {
  const turn = state.turnsById[itemId];
  if (!turn) {
    return state;
  }

  const hasTranscript = (turn.transcriptFinal || turn.transcriptDraft).trim().length > 0;
  const hasTranslation = (turn.translationFinal || turn.translationDraft).trim().length > 0;

  if (hasTranscript || hasTranslation) {
    return state;
  }

  const { [itemId]: removedTurn, ...restTurns } = state.turnsById;
  void removedTurn;

  const nextResponseMap = Object.fromEntries(
    Object.entries(state.responseTurnMap).filter(([, mappedItemId]) => mappedItemId !== itemId),
  );

  return {
    ...state,
    turnsById: restTurns,
    orderedTurnIds: state.orderedTurnIds.filter((id) => id !== itemId),
    translationQueue: state.translationQueue.filter((queuedId) => queuedId !== itemId),
    responseTurnMap: nextResponseMap,
    activeTranslationItemId:
      state.activeTranslationItemId === itemId ? null : state.activeTranslationItemId,
  };
}

function pruneAllEmptyTurns(state: TranslatorState) {
  return state.orderedTurnIds.reduce((nextState, turnId) => pruneEmptyTurn(nextState, turnId), state);
}

function ensureTurn(
  state: TranslatorState,
  itemId: string,
  previousItemId: string | null = null,
  sourceLanguage: string | null = null,
) {
  if (state.turnsById[itemId]) {
    return state;
  }

  const nextTurn: TranslationTurn = {
    itemId,
    previousItemId,
    sourceLanguage,
    transcriptDraft: "",
    transcriptFinal: "",
    translationDraft: "",
    translationFinal: "",
    status: "transcribing",
    createdAt: Date.now(),
    responseId: null,
    error: null,
  };

  return {
    ...state,
    turnsById: {
      ...state.turnsById,
      [itemId]: nextTurn,
    },
    orderedTurnIds: insertOrderedTurn(state.orderedTurnIds, itemId, previousItemId),
  };
}

function resolveItemId(
  state: TranslatorState,
  action: {
    responseId?: string;
    itemId?: string;
  },
) {
  if (action.itemId) {
    return action.itemId;
  }

  if (action.responseId) {
    return state.responseTurnMap[action.responseId] ?? state.activeTranslationItemId;
  }

  return state.activeTranslationItemId;
}

export function translatorReducer(
  state: TranslatorState,
  action: TranslatorAction,
): TranslatorState {
  switch (action.type) {
    case "connection/status": {
      const nextState: TranslatorState = {
        ...state,
        connectionStatus: action.status,
        rateLimitMessage: action.status === "connected" ? state.rateLimitMessage : null,
      };

      return action.status === "idle" || action.status === "error"
        ? pruneAllEmptyTurns(nextState)
        : nextState;
    }
    case "error/set":
      return {
        ...state,
        errorMessage: action.message,
      };
    case "rate-limit/set":
      return {
        ...state,
        rateLimitMessage: action.message,
      };
    case "turn/committed": {
      const existing = state.turnsById[action.itemId];
      const nextTurn: TranslationTurn = {
        itemId: action.itemId,
        previousItemId: action.previousItemId,
        sourceLanguage: action.sourceLanguage,
        transcriptDraft: existing?.transcriptDraft ?? "",
        transcriptFinal: existing?.transcriptFinal ?? "",
        translationDraft: existing?.translationDraft ?? "",
        translationFinal: existing?.translationFinal ?? "",
        status: existing?.status ?? "transcribing",
        createdAt: action.createdAt ?? existing?.createdAt ?? Date.now(),
        responseId: existing?.responseId ?? null,
        error: null,
      };
      return {
        ...state,
        turnsById: {
          ...state.turnsById,
          [action.itemId]: nextTurn,
        },
        orderedTurnIds: insertOrderedTurn(
          state.orderedTurnIds,
          action.itemId,
          action.previousItemId,
        ),
      };
    }
    case "turn/transcriptDelta": {
      const nextState = ensureTurn(state, action.itemId);
      const turn = nextState.turnsById[action.itemId];
      const nextTurn: TranslationTurn = {
        ...turn,
        transcriptDraft: `${turn.transcriptDraft}${action.delta}`,
        status: turn.status === "done" ? "done" : "transcribing",
      };

      return {
        ...nextState,
        turnsById: {
          ...nextState.turnsById,
          [action.itemId]: nextTurn,
        },
      };
    }
    case "turn/transcriptCompleted": {
      const nextState = ensureTurn(state, action.itemId);
      const turn = nextState.turnsById[action.itemId];
      const transcript = action.transcript.trim();
      const shouldQueue = transcript.length > 0;
      const nextTurn: TranslationTurn = {
        ...turn,
        transcriptDraft: transcript,
        transcriptFinal: transcript,
        status: shouldQueue ? "queued" : "done",
        error: null,
      };

      const updatedState: TranslatorState = {
        ...nextState,
        turnsById: {
          ...nextState.turnsById,
          [action.itemId]: nextTurn,
        },
        translationQueue: shouldQueue
          ? nextState.translationQueue.includes(action.itemId)
            ? nextState.translationQueue
            : [...nextState.translationQueue, action.itemId]
          : nextState.translationQueue,
      };

      return shouldQueue ? updatedState : pruneEmptyTurn(updatedState, action.itemId);
    }
    case "translation/requested": {
      const turn = state.turnsById[action.itemId];
      if (!turn) {
        return state;
      }

      const nextTurn: TranslationTurn = {
        ...turn,
        status: "translating",
        error: null,
      };

      return {
        ...state,
        translationQueue: state.translationQueue.filter((queuedId) => queuedId !== action.itemId),
        activeTranslationItemId: action.itemId,
        turnsById: {
          ...state.turnsById,
          [action.itemId]: nextTurn,
        },
      };
    }
    case "translation/responseCreated": {
      const itemId = resolveItemId(state, action);
      if (!itemId) {
        return state;
      }

      const turn = state.turnsById[itemId];
      if (!turn) {
        return state;
      }

      const nextTurn: TranslationTurn = {
        ...turn,
        responseId: action.responseId,
      };

      return {
        ...state,
        responseTurnMap: {
          ...state.responseTurnMap,
          [action.responseId]: itemId,
        },
        turnsById: {
          ...state.turnsById,
          [itemId]: nextTurn,
        },
      };
    }
    case "translation/delta": {
      const itemId = resolveItemId(state, action);
      if (!itemId) {
        return state;
      }

      const turn = state.turnsById[itemId];
      if (!turn) {
        return state;
      }

      const nextTurn: TranslationTurn = {
        ...turn,
        translationDraft: `${turn.translationDraft}${action.delta}`,
        status: "translating",
      };

      return {
        ...state,
        turnsById: {
          ...state.turnsById,
          [itemId]: nextTurn,
        },
      };
    }
    case "translation/outputDone": {
      const itemId = resolveItemId(state, action);
      if (!itemId) {
        return state;
      }

      const turn = state.turnsById[itemId];
      if (!turn) {
        return state;
      }

      const outputText = action.text.trim();
      const nextTurn: TranslationTurn = {
        ...turn,
        translationDraft: outputText,
        translationFinal: outputText,
        status: outputText ? turn.status : "done",
      };
      const updatedState: TranslatorState = {
        ...state,
        turnsById: {
          ...state.turnsById,
          [itemId]: nextTurn,
        },
      };

      return outputText ? updatedState : pruneEmptyTurn(updatedState, itemId);
    }
    case "translation/responseDone": {
      const itemId = resolveItemId(state, action);
      if (!itemId) {
        return {
          ...state,
          activeTranslationItemId: null,
        };
      }

      const turn = state.turnsById[itemId];
      if (!turn) {
        return {
          ...state,
          activeTranslationItemId: null,
        };
      }

      const finalText = (turn.translationFinal || turn.translationDraft).trim();
      const nextTurn: TranslationTurn = {
        ...turn,
        translationFinal: finalText,
        status: action.failedMessage ? "error" : "done",
        error: action.failedMessage ?? null,
      };
      const nextState: TranslatorState = {
        ...state,
        activeTranslationItemId: null,
        turnsById: {
          ...state.turnsById,
          [itemId]: nextTurn,
        },
      };

      return pruneEmptyTurn(nextState, itemId);
    }
    case "translation/error": {
      const turn = state.turnsById[action.itemId];
      if (!turn) {
        return {
          ...state,
          activeTranslationItemId: null,
          errorMessage: action.message,
        };
      }

      const nextTurn: TranslationTurn = {
        ...turn,
        status: "error",
        error: action.message,
      };

      return {
        ...state,
        activeTranslationItemId: null,
        errorMessage: action.message,
        turnsById: {
          ...state.turnsById,
          [action.itemId]: nextTurn,
        },
      };
    }
    case "clear-turns":
      return {
        ...state,
        turnsById: {},
        orderedTurnIds: [],
        translationQueue: [],
        activeTranslationItemId: null,
        responseTurnMap: {},
        errorMessage: null,
      };
    case "reset":
      return {
        ...initialTranslatorState,
      };
    default:
      return state;
  }
}

export function selectOrderedTurns(state: TranslatorState) {
  return state.orderedTurnIds
    .map((turnId) => state.turnsById[turnId])
    .filter((turn): turn is TranslationTurn => Boolean(turn))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getNextQueuedTurnId(state: TranslatorState) {
  return state.activeTranslationItemId ? null : (state.translationQueue[0] ?? null);
}
