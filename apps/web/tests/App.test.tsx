/**
 * App integration tests — continuous mode orchestration.
 *
 * These tests exercise the App's orchestration logic for continuous mode:
 *   - Normal cycle: VAD fires → encodeWav → streamTranscribeAudio → transcript
 *     accumulates → state returns to "listening"
 *   - Drain-then-done: stop during processing → flag set → segment completes →
 *     state transitions to "done"
 *
 * Push-to-talk behavior is the same as v2.1 (unchanged) and is not re-tested here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { App } from "../src/app/App";
import type { WsCompleteMessage } from "../src/types";

// ---------------------------------------------------------------------------
// VAD mock — captures onSpeechEnd so tests can fire it directly
// ---------------------------------------------------------------------------

let capturedOnSpeechEnd: ((audio: Float32Array) => void) | undefined;
const mockStartListening = vi.fn().mockResolvedValue(undefined);
const mockStopListening = vi.fn();

// isListening controls whether Recorder shows "Stop" (isRecording || isListening)
let mockIsListening = false;

vi.mock("../src/hooks/useVAD", () => ({
  useVAD: vi.fn((options: { onSpeechEnd: (a: Float32Array) => void }) => {
    capturedOnSpeechEnd = options.onSpeechEnd;
    return {
      startListening: mockStartListening,
      stopListening: mockStopListening,
      isListening: mockIsListening,
      error: null,
    };
  }),
}));

// ---------------------------------------------------------------------------
// streamTranscribeAudio mock — captures callbacks so tests can drive them
// ---------------------------------------------------------------------------

let capturedOnSegment: ((text: string) => void) | undefined;
let capturedOnComplete: ((result: WsCompleteMessage) => void) | undefined;

// Tracks per-call data for concurrent segment tests.
// Each streamTranscribeAudio call pushes an entry with its own callbacks and cleanup fn.
const streamCalls: Array<{
  onComplete: (result: WsCompleteMessage) => void;
  onConnectionError: () => void;
  onApplicationError: (detail: string) => void;
  cleanup: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../src/services/api", () => ({
  streamTranscribeAudio: vi.fn(
    (
      _blob: Blob,
      onSegment: (text: string) => void,
      onComplete: (result: WsCompleteMessage) => void,
      onConnectionError: () => void,
      onApplicationError: (detail: string) => void
    ) => {
      capturedOnSegment = onSegment;
      capturedOnComplete = onComplete;
      const cleanup = vi.fn();
      streamCalls.push({ onComplete, onConnectionError, onApplicationError, cleanup });
      return cleanup;
    }
  ),
  transcribeAudio: vi.fn(),
  listModels: vi
    .fn()
    .mockResolvedValue({ models: [], current_model: "" }),
  swapModel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// encodeWav mock — returns a dummy Blob, records calls
// ---------------------------------------------------------------------------

const dummyBlob = new Blob(["wav"], { type: "audio/wav" });

vi.mock("../src/utils/audio", () => ({
  encodeWav: vi.fn(() => dummyBlob),
  encodeWavBuffer: vi.fn(),
}));

import { encodeWav } from "../src/utils/audio";
import { streamTranscribeAudio } from "../src/services/api";

// ---------------------------------------------------------------------------
// useRecorder mock — stable stubs, no actual MediaRecorder
// ---------------------------------------------------------------------------

vi.mock("../src/hooks/useRecorder", () => ({
  useRecorder: () => ({
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    audioBlob: null,
    isRecording: false,
    error: null,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPLETE_RESULT: WsCompleteMessage = {
  type: "complete",
  raw: "hello raw",
  cleaned: "hello",
  language: "en",
  duration: 1.0,
  processing_mode: "ws",
  model_name: "small",
};

function setContinuousMode() {
  localStorage.setItem("voice-scribe-recording-mode", "continuous");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Command-carrying complete result — the entire segment is a command phrase.
function commandResult(cleaned: string): WsCompleteMessage {
  return { ...COMPLETE_RESULT, cleaned, raw: cleaned };
}

// ---------------------------------------------------------------------------
// Voice command tests
// ---------------------------------------------------------------------------

describe("App — voice commands (continuous mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSpeechEnd = undefined;
    capturedOnSegment = undefined;
    capturedOnComplete = undefined;
    streamCalls.length = 0;
    mockIsListening = true;
    localStorage.clear();
    localStorage.setItem("voice-scribe-recording-mode", "continuous");

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('"copy" writes accumulated transcript to clipboard, transcript remains', async () => {
    render(<App />);

    // Accumulate a transcript via a normal segment first
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(COMPLETE_RESULT); }); // cleaned: "hello"
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    // Fire "copy" on the next VAD cycle
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(commandResult("Copy.")); });

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
    });

    // Transcript is not cleared by copy — still present
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("hello");
  });

  it('"clear" clears transcript, VAD stays active (no stopListening)', async () => {
    render(<App />);

    // Accumulate transcript
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(COMPLETE_RESULT); });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    // Fire "clear"
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(commandResult("Clear.")); });

    await waitFor(() => {
      expect(screen.queryByText("Transcribing...")).toBeNull();
    });

    // Transcript cleared — textarea absent (nothing to show)
    expect(screen.queryByRole("textbox")).toBeNull();
    // VAD not stopped — mic stays open
    expect(mockStopListening).not.toHaveBeenCalled();
  });

  it("non-command segment accumulates normally with no side effects", async () => {
    render(<App />);

    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(COMPLETE_RESULT); });

    await waitFor(() => {
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(textarea.value).toContain("hello");
    });

    expect(mockStopListening).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("App — continuous mode orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSpeechEnd = undefined;
    capturedOnSegment = undefined;
    capturedOnComplete = undefined;
    streamCalls.length = 0;
    mockIsListening = false;
    localStorage.clear();

    // jsdom doesn't provide navigator.clipboard — assign a stub
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("VAD fires onSpeechEnd → encodeWav called → streamTranscribeAudio invoked → transcript accumulates → state returns to listening", async () => {
    // Start with continuous mode and VAD listening
    setContinuousMode();
    mockIsListening = true;

    render(<App />);

    // Simulate VAD detecting speech end — triggers the full pipeline
    act(() => {
      const audio = new Float32Array([0.1, 0.2]);
      capturedOnSpeechEnd!(audio);
    });

    // encodeWav must have been called with the Float32Array
    expect(encodeWav).toHaveBeenCalledOnce();
    expect(encodeWav).toHaveBeenCalledWith(expect.any(Float32Array), 16000);

    // streamTranscribeAudio must have been called with the encoded blob
    expect(streamTranscribeAudio).toHaveBeenCalledOnce();
    expect(streamTranscribeAudio).toHaveBeenCalledWith(
      dummyBlob,
      expect.any(Function), // onSegment
      expect.any(Function), // onComplete
      expect.any(Function), // onConnectionError
      expect.any(Function)  // onApplicationError
    );

    // App should be in processing state — Transcript shows loading indicator
    expect(screen.getByText("Transcribing...")).toBeTruthy();

    // In continuous mode, onSegment does NOT update the transcript (avoids
    // duplication when onComplete also appends the final cleaned text).
    act(() => {
      capturedOnSegment!("hello");
    });
    // Transcript still empty — segment was ignored in continuous mode
    expect(screen.queryByRole("textbox")).toBeNull();

    // onComplete fires — normal continuous cycle (no stop requested)
    act(() => {
      capturedOnComplete!(COMPLETE_RESULT);
    });

    // Transcript shows the cleaned text from onComplete only (no duplicate)
    await waitFor(() => {
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(textarea.value).toContain("hello");
    });

    // State returned to "listening" — loading indicator is gone
    expect(screen.queryByText("Transcribing...")).toBeNull();
  });

  it("explicit stop during processing → drain-then-done: segment completes → state is done, not listening", async () => {
    setContinuousMode();
    mockIsListening = true;

    render(<App />);

    // VAD fires — state transitions to processing
    act(() => {
      capturedOnSpeechEnd!(new Float32Array([0.5]));
    });

    // Verify we're in processing state
    expect(screen.getByText("Transcribing...")).toBeTruthy();

    // User clicks Stop while processing — Stop button is visible because
    // isRecording={isRecording || isListening}=true and it takes priority
    // over the "Processing..." label. Button is NOT disabled in continuous
    // mode while isListening=true.
    const stopBtn = screen.getByText("Stop");
    act(() => {
      fireEvent.click(stopBtn);
    });

    // stopListening must have been called
    expect(mockStopListening).toHaveBeenCalledOnce();

    // Segment completes — App should see stopRequested flag and go to done
    act(() => {
      capturedOnComplete!(COMPLETE_RESULT);
    });

    // State is "done" — loading indicator gone, transcript present
    await waitFor(() => {
      expect(screen.queryByText("Transcribing...")).toBeNull();
    });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("hello");

    // stopListening called once (on explicit stop — not called again on complete)
    expect(mockStopListening).toHaveBeenCalledTimes(1);
  });
});

describe("App — wsCleanupSet lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSpeechEnd = undefined;
    capturedOnSegment = undefined;
    capturedOnComplete = undefined;
    streamCalls.length = 0;
    mockIsListening = true;
    localStorage.clear();
    localStorage.setItem("voice-scribe-recording-mode", "continuous");

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("unmount cleans up all in-flight connections, not just the last", () => {
    const { unmount } = render(<App />);

    // Fire three concurrent VAD segments — each creates a new WebSocket
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.2])); });
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.3])); });

    expect(streamCalls).toHaveLength(3);

    // Unmount before any segment completes
    unmount();

    // All three cleanup functions must have been called
    streamCalls.forEach(({ cleanup }) => {
      expect(cleanup).toHaveBeenCalledOnce();
    });
  });

  it("completed connections are deregistered — unmount only cleans in-flight ones", () => {
    const { unmount } = render(<App />);

    // Fire three concurrent VAD segments
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.2])); });
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.3])); });

    expect(streamCalls).toHaveLength(3);

    // Complete the first two connections naturally
    act(() => { streamCalls[0].onComplete(COMPLETE_RESULT); });
    act(() => { streamCalls[1].onComplete(COMPLETE_RESULT); });

    // Clear call counts so we can distinguish unmount cleanup from completion
    streamCalls.forEach(({ cleanup }) => cleanup.mockClear());

    // Unmount — only the third (still in-flight) should be cleaned up
    unmount();

    expect(streamCalls[0].cleanup).not.toHaveBeenCalled();
    expect(streamCalls[1].cleanup).not.toHaveBeenCalled();
    expect(streamCalls[2].cleanup).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Backend readiness gate
// ---------------------------------------------------------------------------

describe("App — backend readiness gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamCalls.length = 0;
    localStorage.clear();
    mockIsListening = false;

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    delete (window as any).__TAURI__;
  });

  it("browser context: Record button enabled on mount — no readiness gate", () => {
    render(<App />);
    const btn = screen.getByText("Record");
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("Tauri context: disabled with 'Starting backend...' until backend-ready event", async () => {
    // Set up __TAURI__ before re-importing App so isDesktop evaluates to true
    let listenCallback: (() => void) | undefined;
    (window as any).__TAURI__ = {
      event: {
        listen: vi.fn((_event: string, cb: () => void) => {
          listenCallback = cb;
          return Promise.resolve(() => {});
        }),
      },
    };

    vi.resetModules();
    const { App: TauriApp } = await import("../src/app/App");

    render(<TauriApp />);

    // Button shows "Starting backend..." and is disabled
    const btn = screen.getByText("Starting backend...");
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    // Fire backend-ready event from Rust sidecar
    act(() => {
      listenCallback!();
    });

    // Button transitions to "Record" and is enabled
    await waitFor(() => {
      const recordBtn = screen.getByText("Record");
      expect(recordBtn).toBeTruthy();
      expect((recordBtn as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Desktop voice command clipboard routing
// ---------------------------------------------------------------------------

describe("App — desktop voice command clipboard routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamCalls.length = 0;
    localStorage.clear();
    localStorage.setItem("voice-scribe-recording-mode", "continuous");
    // Start with isListening=false so the readiness gate renders
    // "Starting backend..." before backend-ready fires.
    mockIsListening = false;

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    delete (window as any).__TAURI__;
  });

  it('"copy" voice command routes through HTTP clipboard server, not navigator.clipboard', async () => {
    // Set up __TAURI__ with event.listen so backend-ready can fire
    let listenCallback: (() => void) | undefined;
    (window as any).__TAURI__ = {
      event: {
        listen: vi.fn((_event: string, cb: () => void) => {
          listenCallback = cb;
          return Promise.resolve(() => {});
        }),
      },
    };

    // Mock fetch for the HTTP clipboard server (127.0.0.1:8001)
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    // Re-import App so isDesktop() evaluates with __TAURI__ present
    vi.resetModules();
    const { App: TauriApp } = await import("../src/app/App");

    // Verify isDesktop returns true in this test environment
    const { isDesktop } = await import("../src/services/platform");
    expect(isDesktop()).toBe(true);

    render(<TauriApp />);

    // Button shows "Starting backend..." initially (readiness gate)
    expect(screen.getByText("Starting backend...")).toBeTruthy();

    // Fire backend-ready event — button transitions to "Record"
    act(() => { listenCallback!(); });
    await waitFor(() => {
      expect(screen.getByText("Record")).toBeTruthy();
    });

    // Click Record to start continuous mode — switch isListening so
    // useVAD mock reflects active listening state
    mockIsListening = true;
    act(() => { fireEvent.click(screen.getByText("Record")); });

    // Accumulate transcript via normal VAD cycle
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => {
      capturedOnComplete!({
        type: "complete",
        raw: "hello raw",
        cleaned: "hello",
        language: "en",
        duration: 1.0,
        processing_mode: "ws",
        model_name: "small",
      });
    });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    // Fire "copy" voice command
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => {
      capturedOnComplete!({
        type: "complete",
        raw: "Copy.",
        cleaned: "Copy.",
        language: "en",
        duration: 0.5,
        processing_mode: "ws",
        model_name: "small",
      });
    });

    // Assert: HTTP clipboard server was called with transcript text
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8001/clipboard",
        { method: "POST", body: "hello" }
      );
    });

    // Assert: navigator.clipboard.writeText was NOT called
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
