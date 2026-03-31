import { describe, expect, it } from "vitest";
import {
  getNextQueuedTurnId,
  initialTranslatorState,
  selectOrderedTurns,
  translatorReducer,
} from "@/lib/realtime-store";

describe("translatorReducer", () => {
  it("moves a turn through transcription and translation", () => {
    let state = initialTranslatorState;

    state = translatorReducer(state, {
      type: "turn/committed",
      itemId: "turn-1",
      previousItemId: null,
      sourceLanguage: "ko",
      createdAt: 10,
    });
    state = translatorReducer(state, {
      type: "turn/transcriptCompleted",
      itemId: "turn-1",
      transcript: "\uC548\uB155\uD558\uC138\uC694",
    });

    expect(getNextQueuedTurnId(state)).toBe("turn-1");

    state = translatorReducer(state, {
      type: "translation/requested",
      itemId: "turn-1",
    });
    state = translatorReducer(state, {
      type: "translation/responseCreated",
      responseId: "response-1",
      itemId: "turn-1",
    });
    state = translatorReducer(state, {
      type: "translation/delta",
      responseId: "response-1",
      delta: "Hello",
    });
    state = translatorReducer(state, {
      type: "translation/outputDone",
      responseId: "response-1",
      text: "Hello.",
    });
    state = translatorReducer(state, {
      type: "translation/responseDone",
      responseId: "response-1",
    });

    const [turn] = selectOrderedTurns(state);
    expect(turn.transcriptFinal).toBe("\uC548\uB155\uD558\uC138\uC694");
    expect(turn.translationFinal).toBe("Hello.");
    expect(turn.status).toBe("done");
    expect(getNextQueuedTurnId(state)).toBeNull();
  });

  it("drops empty turns once transcription finishes with no content", () => {
    let state = translatorReducer(initialTranslatorState, {
      type: "turn/committed",
      itemId: "turn-empty",
      previousItemId: null,
      sourceLanguage: null,
      createdAt: 20,
    });

    state = translatorReducer(state, {
      type: "turn/transcriptCompleted",
      itemId: "turn-empty",
      transcript: "   ",
    });

    expect(selectOrderedTurns(state)).toEqual([]);
    expect(state.turnsById).toEqual({});
  });

  it("prunes empty placeholder turns when the session goes idle", () => {
    let state = translatorReducer(initialTranslatorState, {
      type: "turn/committed",
      itemId: "turn-pending",
      previousItemId: null,
      sourceLanguage: null,
      createdAt: 25,
    });

    state = translatorReducer(state, {
      type: "rate-limit/set",
      message: "Realtime usage is getting close to the limit. Resets in 5s.",
    });
    state = translatorReducer(state, {
      type: "connection/status",
      status: "idle",
    });

    expect(selectOrderedTurns(state)).toEqual([]);
    expect(state.turnsById).toEqual({});
    expect(state.rateLimitMessage).toBeNull();
  });

  it("keeps turns ordered by creation time for rendering", () => {
    let state = initialTranslatorState;

    state = translatorReducer(state, {
      type: "turn/committed",
      itemId: "turn-b",
      previousItemId: "turn-a",
      sourceLanguage: "en",
      createdAt: 30,
    });
    state = translatorReducer(state, {
      type: "turn/committed",
      itemId: "turn-a",
      previousItemId: null,
      sourceLanguage: "ko",
      createdAt: 10,
    });

    expect(selectOrderedTurns(state).map((turn) => turn.itemId)).toEqual(["turn-a", "turn-b"]);
  });
});