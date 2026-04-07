import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { negotiateMimeType, useRecorder } from "../src/hooks/useRecorder";

// ---------------------------------------------------------------------------
// negotiateMimeType — MIME negotiation unit tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// useRecorder — ScriptProcessorNode PCM fallback
// ---------------------------------------------------------------------------

describe("useRecorder — ScriptProcessorNode fallback", () => {
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalAudioContext = globalThis.AudioContext;
  const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;

  afterEach(() => {
    if (originalMediaRecorder) {
      globalThis.MediaRecorder = originalMediaRecorder;
    } else {
      delete (globalThis as Record<string, unknown>).MediaRecorder;
    }
    if (originalAudioContext) {
      globalThis.AudioContext = originalAudioContext;
    } else {
      delete (globalThis as Record<string, unknown>).AudioContext;
    }
    if (originalGetUserMedia) {
      navigator.mediaDevices.getUserMedia = originalGetUserMedia;
    }
  });

  function setupFallbackMocks() {
    // MediaRecorder supports nothing → triggers fallback
    globalThis.MediaRecorder = {
      isTypeSupported: vi.fn(() => false),
    } as unknown as typeof MediaRecorder;

    // Fake getUserMedia stream
    const fakeTrack = { stop: vi.fn() };
    const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        value: {},
        writable: true,
        configurable: true,
      });
    }
    navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(fakeStream);

    // Capture the onaudioprocess handler so we can call it
    let audioProcessHandler: ((event: AudioProcessingEvent) => void) | null = null;
    const mockScriptNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      set onaudioprocess(handler: (event: AudioProcessingEvent) => void) {
        audioProcessHandler = handler;
      },
    };
    const mockSource = { connect: vi.fn() };
    const mockAudioContext = {
      sampleRate: 16000,
      createMediaStreamSource: vi.fn(() => mockSource),
      createScriptProcessor: vi.fn(() => mockScriptNode),
      close: vi.fn(),
      destination: {},
    };

    globalThis.AudioContext = vi.fn(() => mockAudioContext) as unknown as typeof AudioContext;

    return {
      fakeTrack,
      mockScriptNode,
      mockSource,
      mockAudioContext,
      getAudioProcessHandler: () => audioProcessHandler,
    };
  }

  function makeFakeAudioEvent(samples: Float32Array): AudioProcessingEvent {
    return {
      inputBuffer: {
        getChannelData: vi.fn(() => samples),
      },
    } as unknown as AudioProcessingEvent;
  }

  it("uses ScriptProcessorNode when no MIME type is supported", async () => {
    const mocks = setupFallbackMocks();
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.isRecording).toBe(true);
    expect(mocks.mockAudioContext.createMediaStreamSource).toHaveBeenCalled();
    expect(mocks.mockAudioContext.createScriptProcessor).toHaveBeenCalledWith(4096, 1, 1);
    expect(mocks.mockScriptNode.connect).toHaveBeenCalledWith(mocks.mockAudioContext.destination);
  });

  it("produces a WAV blob from accumulated PCM chunks on stop", async () => {
    const mocks = setupFallbackMocks();
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.startRecording();
    });

    // Simulate two onaudioprocess events with known samples
    const handler = mocks.getAudioProcessHandler();
    expect(handler).not.toBeNull();

    act(() => {
      handler!(makeFakeAudioEvent(new Float32Array([0.1, 0.2, 0.3])));
      handler!(makeFakeAudioEvent(new Float32Array([0.4, 0.5])));
    });

    act(() => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.audioBlob).not.toBeNull();
    });

    const blob = result.current.audioBlob!;
    expect(blob.type).toBe("audio/wav");
    // WAV header (44 bytes) + 5 samples * 2 bytes = 54 bytes
    expect(blob.size).toBe(54);
    expect(result.current.isRecording).toBe(false);
  });

  it("cleans up AudioContext and stream on stop", async () => {
    const mocks = setupFallbackMocks();
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.startRecording();
    });

    act(() => {
      result.current.stopRecording();
    });

    await waitFor(() => {
      expect(result.current.audioBlob).not.toBeNull();
    });

    expect(mocks.mockScriptNode.disconnect).toHaveBeenCalled();
    expect(mocks.mockAudioContext.close).toHaveBeenCalled();
    expect(mocks.fakeTrack.stop).toHaveBeenCalled();
  });
});
