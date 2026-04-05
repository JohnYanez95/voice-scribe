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

import { describe, it, expect, vi, beforeEach } from "vitest";
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
const mockStreamCleanup = vi.fn().mockReturnValue(undefined);

vi.mock("../src/services/api", () => ({
  streamTranscribeAudio: vi.fn(
    (
      _blob: Blob,
      onSegment: (text: string) => void,
      onComplete: (result: WsCompleteMessage) => void
    ) => {
      capturedOnSegment = onSegment;
      capturedOnComplete = onComplete;
      return mockStreamCleanup;
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
    mockIsListening = true;
    localStorage.clear();
    localStorage.setItem("voice-scribe-recording-mode", "continuous");

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('"scribe stop" consumes segment, calls stopListening, state → done, no transcript added', async () => {
    render(<App />);

    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(commandResult("Scribe stop.")); });

    // stopListening called by the command handler (inside onComplete)
    expect(mockStopListening).toHaveBeenCalledOnce();

    // State lands at done — spinner gone, no transcript added
    await waitFor(() => {
      expect(screen.queryByText("Transcribing...")).toBeNull();
    });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it('"scribe submit" writes accumulated transcript to clipboard', async () => {
    render(<App />);

    // Accumulate a transcript via a normal segment first
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(COMPLETE_RESULT); }); // cleaned: "hello"
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    // Fire "scribe submit" on the next VAD cycle
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(commandResult("Scribe submit.")); });

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
    });

    // Transcript is not cleared by submit — still present
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("hello");
  });

  it('"scribe clear" clears transcript, VAD stays active (no stopListening)', async () => {
    render(<App />);

    // Accumulate transcript
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(COMPLETE_RESULT); });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    // Fire "scribe clear"
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(commandResult("Scribe clear.")); });

    await waitFor(() => {
      expect(screen.queryByText("Transcribing...")).toBeNull();
    });

    // Transcript cleared — textarea absent (nothing to show)
    expect(screen.queryByRole("textbox")).toBeNull();
    // VAD not stopped — mic stays open
    expect(mockStopListening).not.toHaveBeenCalled();
  });

  it('"scribe redo" clears transcript identically to "scribe clear"', async () => {
    render(<App />);

    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(COMPLETE_RESULT); });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(commandResult("Scribe Redo.")); });

    await waitFor(() => {
      expect(screen.queryByText("Transcribing...")).toBeNull();
    });
    expect(screen.queryByRole("textbox")).toBeNull();
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

// ---------------------------------------------------------------------------
// Hotkey: paragraph break (Ctrl+Shift+R)
// ---------------------------------------------------------------------------

describe("App — hotkey Ctrl+Shift+R paragraph break", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSpeechEnd = undefined;
    capturedOnComplete = undefined;
    mockIsListening = true;
    localStorage.clear();
    localStorage.setItem("voice-scribe-recording-mode", "continuous");

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("inserts \\n\\n into transcript when content is present", async () => {
    render(<App />);

    // Accumulate transcript
    act(() => { capturedOnSpeechEnd!(new Float32Array([0.1])); });
    act(() => { capturedOnComplete!(COMPLETE_RESULT); }); // "hello"
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());

    // Fire Ctrl+Shift+R
    act(() => {
      fireEvent.keyDown(document, { key: "R", ctrlKey: true, shiftKey: true });
    });

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello\n\n");
  });

  it("does nothing when transcript is empty", async () => {
    render(<App />);

    act(() => {
      fireEvent.keyDown(document, { key: "R", ctrlKey: true, shiftKey: true });
    });

    // No textarea — transcript is still empty
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("App — continuous mode orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSpeechEnd = undefined;
    capturedOnSegment = undefined;
    capturedOnComplete = undefined;
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
