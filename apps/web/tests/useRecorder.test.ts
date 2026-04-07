import { describe, it, expect, vi, afterEach } from "vitest";
import { negotiateMimeType } from "../src/hooks/useRecorder";

describe("negotiateMimeType", () => {
  const originalMediaRecorder = globalThis.MediaRecorder;

  afterEach(() => {
    if (originalMediaRecorder) {
      globalThis.MediaRecorder = originalMediaRecorder;
    } else {
      delete (globalThis as Record<string, unknown>).MediaRecorder;
    }
  });

  function mockIsTypeSupported(supported: string[]) {
    globalThis.MediaRecorder = {
      isTypeSupported: vi.fn((mime: string) => supported.includes(mime)),
    } as unknown as typeof MediaRecorder;
  }

  it("prefers webm/opus when available", () => {
    mockIsTypeSupported([
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm",
      "audio/ogg",
    ]);
    expect(negotiateMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("falls back to ogg/opus when webm variants unsupported", () => {
    mockIsTypeSupported(["audio/ogg;codecs=opus", "audio/ogg"]);
    expect(negotiateMimeType()).toBe("audio/ogg;codecs=opus");
  });

  it("falls back to bare ogg when only ogg supported", () => {
    mockIsTypeSupported(["audio/ogg"]);
    expect(negotiateMimeType()).toBe("audio/ogg");
  });

  it("returns null when no format supported", () => {
    mockIsTypeSupported([]);
    expect(negotiateMimeType()).toBeNull();
  });
});
