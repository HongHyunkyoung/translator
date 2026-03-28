import { describe, expect, it } from "vitest";
import { extractGeminiServerEventText, mergeGeminiTranscript, parseGeminiServerEvent } from "@/lib/realtime-client";

describe("extractGeminiServerEventText", () => {
  it("returns JSON text frames", async () => {
    const payload = '{"setupComplete":{}}';

    await expect(extractGeminiServerEventText(payload)).resolves.toBe(payload);
  });

  it("decodes JSON array buffers and ignores non-JSON frames", async () => {
    const payload = '{"setupComplete":{}}';
    const buffer = new TextEncoder().encode(payload).buffer;

    await expect(extractGeminiServerEventText(payload)).resolves.toBe(payload);
    await expect(extractGeminiServerEventText(buffer)).resolves.toBe(payload);
    await expect(extractGeminiServerEventText("binary-audio-frame")).resolves.toBeNull();
    await expect(extractGeminiServerEventText(new ArrayBuffer(8))).resolves.toBeNull();
  });


  it("recognizes Gemini turn completion signals", () => {
    expect(
      parseGeminiServerEvent(
        '{"serverContent":{"inputTranscription":{"text":"hello"},"turnComplete":true}}',
      ),
    ).toEqual({
      setupComplete: false,
      turnComplete: true,
      inputTranscription: {
        text: "hello",
        finished: false,
      },
    });
  });

  it("merges incremental Gemini transcript chunks without dropping the prefix", () => {
    expect(mergeGeminiTranscript("he", "llo there")).toBe("hello there");
    expect(mergeGeminiTranscript("hello ", "world")).toBe("hello world");
    expect(mergeGeminiTranscript("hello ", "hello world")).toBe("hello world");
  });

  it("reads JSON blobs and ignores binary blobs", async () => {
    const payload = '{"serverContent":{"inputTranscription":{"text":"hello"}}}';

    await expect(
      extractGeminiServerEventText(new Blob([payload], { type: "application/json" })),
    ).resolves.toBe(payload);

    await expect(
      extractGeminiServerEventText(new Blob([Uint8Array.from([0, 159, 255])])),
    ).resolves.toBeNull();
  });
});
