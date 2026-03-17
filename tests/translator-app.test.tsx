import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TranslatorApp } from "@/components/translator-app";
import type { RealtimeClientCallbacks, TranslatorClient } from "@/lib/realtime-client";

function renderTranslatorApp() {
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

  render(<TranslatorApp clientFactory={clientFactory} />);

  return {
    user: userEvent.setup(),
    client,
    callbacks,
    clientFactory,
  };
}

describe("TranslatorApp", () => {
  it("updates settings when the source mode changes", async () => {
    const { user, client } = renderTranslatorApp();

    const sourceMode = screen.getByLabelText("Source mode");
    const manualSourceLanguage = screen.getByLabelText("Manual source language");

    expect(manualSourceLanguage).toBeDisabled();

    await user.selectOptions(sourceMode, "manual");

    expect(manualSourceLanguage).toBeEnabled();
    await waitFor(() => {
      expect(client.updateSettings).toHaveBeenLastCalledWith({
        targetLanguage: "en",
        sourceLanguageMode: "manual",
        sourceLanguage: "ko",
      });
    });
  });

  it("starts listening, requests translation, and copies the transcript", async () => {
    const { user, client, callbacks } = renderTranslatorApp();

    await user.click(screen.getByRole("button", { name: "Start listening" }));

    expect(client.connect).toHaveBeenCalledWith({
      settings: {
        targetLanguage: "en",
        sourceLanguageMode: "auto",
        sourceLanguage: "ko",
      },
    });

    act(() => {
      callbacks.onConnectionStatus("connected");
      callbacks.onTurnCommitted({
        itemId: "turn-1",
        previousItemId: null,
        sourceLanguage: "ko",
      });
      callbacks.onTranscriptCompleted({
        itemId: "turn-1",
        transcript: "æ»≥Á«œººø‰",
      });
    });

    await waitFor(() => {
      expect(client.requestTranslation).toHaveBeenCalledWith("turn-1", {
        targetLanguage: "en",
        sourceLanguageMode: "auto",
        sourceLanguage: "ko",
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

    expect(await screen.findByText("æ»≥Á«œººø‰")).toBeInTheDocument();
    expect(await screen.findByText("Hello")).toBeInTheDocument();

    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    await user.click(screen.getByRole("button", { name: "Copy transcript" }));

    expect(writeText).toHaveBeenCalledWith("æ»≥Á«œººø‰");
    expect(await screen.findByText("Transcript copied.")).toBeInTheDocument();
  });
});
