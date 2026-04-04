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

    // Segment arrives before complete
    act(() => {
      capturedOnSegment!("hello");
    });

    // onComplete fires — normal continuous cycle (no stop requested)
    act(() => {
      capturedOnComplete!(COMPLETE_RESULT);
    });

    // Transcript should contain the cleaned segment text
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
