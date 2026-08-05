/**
 * App streaming integration (v4.1) — persistent /ws/stream session in
 * continuous mode. streamSession is mocked at the module boundary (same style
 * as the api.ts mocks); the session-vs-wire behavior is covered by
 * streamSession.test.ts against the WebSocket fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { WsStreamFinalMessage } from "../src/types";

// ---------------------------------------------------------------------------
// streamSession mock — controllable sessions, one entry per open call
// ---------------------------------------------------------------------------

interface CapturedCallbacks {
  onPartial: (m: { type: "partial"; seq: number; utterance_id: number; text: string }) => void;
  onCommitted: (m: {
    type: "committed";
    seq: number;
    utterance_id: number;
    text: string;
    t0: number;
    t1: number;
    forced: boolean;
  }) => void;
  onFinal: (m: WsStreamFinalMessage) => void;
  onDegrade: (r: unknown) => void;
  onSurfaceError: (d: string) => void;
  onStopped?: () => void;
}

interface MockSession {
  sendAudio: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  age: () => number;
  state: string;
}

const sessions: Array<{ cb: CapturedCallbacks; session: MockSession }> = [];
let sessionAge = 0;

vi.mock("../src/services/streamSession", () => ({
  openStreamSession: vi.fn((_opts: unknown, cb: CapturedCallbacks) => {
    const session: MockSession = {
      sendAudio: vi.fn(),
      flush: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
      age: () => sessionAge,
      state: "open",
    };
    sessions.push({ cb, session });
    return session;
  }),
}));

// ---------------------------------------------------------------------------
// VAD / api / audio / platform mocks
// ---------------------------------------------------------------------------

let capturedOnSpeechStart: (() => void) | undefined;
let capturedOnSpeechEnd: ((audio: Float32Array) => void) | undefined;
let capturedOnSpeechFrame: ((frame: Float32Array) => void) | undefined;
let capturedOnVADMisfire: (() => void) | undefined;
let mockIsListening = false;

vi.mock("../src/hooks/useVAD", () => ({
  useVAD: vi.fn(
    (options: {
      onSpeechStart?: () => void;
      onSpeechEnd: (a: Float32Array) => void;
      onSpeechFrame?: (f: Float32Array) => void;
      onVADMisfire?: () => void;
    }) => {
      capturedOnSpeechStart = options.onSpeechStart;
      capturedOnSpeechEnd = options.onSpeechEnd;
      capturedOnSpeechFrame = options.onSpeechFrame;
      capturedOnVADMisfire = options.onVADMisfire;
      return {
        startListening: vi.fn().mockResolvedValue(undefined),
        stopListening: vi.fn(),
        isListening: mockIsListening,
        error: null,
      };
    }
  ),
}));

// Captured per-call one-shot callbacks so tests can drive success/failure
// (existing tests only assert call counts — callbacks never auto-fire).
interface CapturedStreamCall {
  blob: Blob;
  onSegment: (t: string) => void;
  onComplete: (r: { raw: string; cleaned: string }) => void;
  onConnectionFail: () => void;
  onAppError: (d: string) => void;
}
const streamCalls: CapturedStreamCall[] = [];
const mockStreamTranscribeAudio = vi.fn(
  (blob: Blob, onSegment: (t: string) => void,
   onComplete: (r: { raw: string; cleaned: string }) => void,
   onConnectionFail: () => void, onAppError: (d: string) => void) => {
    streamCalls.push({ blob, onSegment, onComplete, onConnectionFail, onAppError });
    return vi.fn();
  }
);
vi.mock("../src/services/api", () => ({
  streamTranscribeAudio: (...args: unknown[]) => mockStreamTranscribeAudio(...args),
  transcribeAudio: vi.fn(),
  listModels: vi.fn().mockResolvedValue({
    models: [{ name: "small", is_current: true }],
    current_model: "small",
  }),
  swapModel: vi.fn(),
}));

vi.mock("../src/utils/audio", () => ({
  encodeWav: vi.fn(() => new Blob(["wav"], { type: "audio/wav" })),
  encodeWavBuffer: vi.fn(),
}));

const mockPlayCopySound = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/audio", () => ({
  playCopySound: (...args: unknown[]) => mockPlayCopySound(...args),
  playClearSound: vi.fn().mockResolvedValue(undefined),
  initAudio: vi.fn().mockResolvedValue(undefined),
  setAudioMuted: vi.fn(),
  isAudioMuted: vi.fn(() => false),
}));

const mockWriteClipboard = vi.fn().mockResolvedValue(undefined);
const mockEmitRecordingState = vi.fn();
vi.mock("../src/services/platform", () => ({
  isDesktop: () => false,
  writeClipboard: (...args: unknown[]) => mockWriteClipboard(...args),
  emitRecordingState: (...args: unknown[]) => mockEmitRecordingState(...args),
  submitText: vi.fn(),
}));

vi.mock("../src/hooks/useRecorder", () => ({
  useRecorder: () => ({
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    audioBlob: null,
    isRecording: false,
    error: null,
  }),
}));

import { App } from "../src/app/App";
import { openStreamSession } from "../src/services/streamSession";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
const finalMsg = (
  utterance_id: number,
  raw: string,
  over: Partial<WsStreamFinalMessage> = {}
): WsStreamFinalMessage => ({
  type: "final",
  seq: ++seq,
  utterance_id,
  raw,
  cleaned: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) + "." : "",
  language: "en",
  duration: 2,
  model_name: "small",
  processing_mode: "stream",
  dropped_audio_ms: 0,
  forced: false,
  ...over,
});

function startContinuous() {
  mockIsListening = false;
  render(<App />);
  // Flip before the click: the click's own re-render then reads
  // isListening=true, so the button shows "Stop" (existing suite pattern).
  mockIsListening = true;
  act(() => {
    fireEvent.click(screen.getByText("Record"));
  });
  return sessions[0];
}

/** One full utterance: speech start, one frame, speech end (flush). */
function speakUtterance(entry: { cb: CapturedCallbacks; session: MockSession }, id: number) {
  act(() => {
    capturedOnSpeechStart?.();
    capturedOnSpeechFrame?.(new Float32Array(1536));
    capturedOnSpeechEnd?.(new Float32Array([0.1]));
  });
}

const getTextarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("voice-scribe-recording-mode", "continuous");
  sessions.length = 0;
  streamCalls.length = 0;
  sessionAge = 0;
  seq = 0;
  mockIsListening = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("App streaming — session lifecycle", () => {
  it("opens ONE session per continuous activation across N utterances (churn eliminated)", () => {
    const entry = startContinuous();
    expect(openStreamSession).toHaveBeenCalledOnce();

    for (let i = 0; i < 3; i++) {
      speakUtterance(entry, i);
      act(() => {
        entry.cb.onFinal(finalMsg(i, `utterance ${i}`));
      });
    }
    expect(openStreamSession).toHaveBeenCalledOnce();
    expect(entry.session.flush).toHaveBeenCalledTimes(3);
    expect(mockStreamTranscribeAudio).not.toHaveBeenCalled(); // one-shot path idle
  });

  it("routes frames to sendAudio only while streaming", () => {
    const entry = startContinuous();
    act(() => {
      capturedOnSpeechStart?.();
      capturedOnSpeechFrame?.(new Float32Array(1536));
      capturedOnSpeechFrame?.(new Float32Array(1536));
    });
    expect(entry.session.sendAudio).toHaveBeenCalledTimes(2);
  });

  it("unmount closes the session via the wsCleanupSet discipline", () => {
    mockIsListening = false;
    const { unmount } = render(<App />);
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    const entry = sessions[0];
    unmount();
    expect(entry.session.close).toHaveBeenCalled();
  });

  it("push-to-talk never opens a session", () => {
    localStorage.setItem("voice-scribe-recording-mode", "push-to-talk");
    render(<App />);
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    expect(openStreamSession).not.toHaveBeenCalled();
  });

  it("rotates the session at an idle boundary past the age threshold (C1.6)", () => {
    const entry = startContinuous();
    sessionAge = 1600; // past SESSION_ROTATE_S
    speakUtterance(entry, 0);
    act(() => {
      entry.cb.onFinal(finalMsg(0, "hello"));
    });
    expect(entry.session.close).toHaveBeenCalled();
    expect(openStreamSession).toHaveBeenCalledTimes(2);
  });
});

describe("App streaming — rendering", () => {
  it("partial → gray tail; committed → live text grows, tail cleared; final → textarea", () => {
    const entry = startContinuous();
    act(() => {
      capturedOnSpeechStart?.();
      entry.cb.onPartial({ type: "partial", seq: 1, utterance_id: 0, text: "hel" });
    });
    let live = screen.getByTestId("transcript-live");
    expect(live.querySelector(".tentative")?.textContent).toContain("hel");

    act(() => {
      entry.cb.onCommitted({
        type: "committed",
        seq: 2,
        utterance_id: 0,
        text: "hello",
        t0: 0,
        t1: 1,
        forced: false,
      });
    });
    live = screen.getByTestId("transcript-live");
    expect(live.textContent).toBe("hello");
    expect(live.querySelector(".tentative")).toBeNull(); // tail cleared

    act(() => {
      capturedOnSpeechEnd?.(new Float32Array([0.1]));
      entry.cb.onFinal(finalMsg(0, "hello world"));
    });
    expect(screen.queryByTestId("transcript-live")).toBeNull(); // live region cleared
    expect(getTextarea().value).toBe("Hello world.");
  });

  it("partial text never reaches the textarea (C4.2)", () => {
    const entry = startContinuous();
    act(() => {
      capturedOnSpeechEnd?.(new Float32Array([0.1])); // pending utterance 0
      entry.cb.onFinal(finalMsg(0, "finalized"));
    });
    act(() => {
      capturedOnSpeechStart?.();
      entry.cb.onPartial({ type: "partial", seq: 9, utterance_id: 1, text: "tentative words" });
    });
    expect(getTextarea().value).toBe("Finalized.");
    expect(getTextarea().value).not.toContain("tentative");
  });

  it("separators follow speech-end gaps: space for short, paragraph for long", () => {
    vi.useFakeTimers();
    try {
      const entry = startContinuous();
      speakUtterance(entry, 0);
      act(() => {
        entry.cb.onFinal(finalMsg(0, "first"));
      });
      vi.advanceTimersByTime(1000); // short gap
      speakUtterance(entry, 1);
      act(() => {
        entry.cb.onFinal(finalMsg(1, "second"));
      });
      vi.advanceTimersByTime(5000); // long gap > PARAGRAPH_BREAK_MS
      speakUtterance(entry, 2);
      act(() => {
        entry.cb.onFinal(finalMsg(2, "third"));
      });
      expect(getTextarea().value).toBe("First. Second.\n\nThird.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App streaming — voice commands", () => {
  it("commands fire on final only — committed text never dispatches", () => {
    const entry = startContinuous();
    act(() => {
      capturedOnSpeechEnd?.(new Float32Array([0.1]));
      entry.cb.onFinal(finalMsg(0, "some content"));
    });
    // "copy" arriving as committed (mid-utterance) must not dispatch…
    act(() => {
      capturedOnSpeechStart?.();
      entry.cb.onCommitted({
        type: "committed",
        seq: 5,
        utterance_id: 1,
        text: "copy",
        t0: 0,
        t1: 0.5,
        forced: false,
      });
    });
    expect(mockWriteClipboard).not.toHaveBeenCalled();

    // …but the same word as a final is the v2.3 command path.
    act(() => {
      capturedOnSpeechEnd?.(new Float32Array([0.1]));
      entry.cb.onFinal(finalMsg(1, "copy", { cleaned: "Copy." }));
    });
    expect(mockWriteClipboard).toHaveBeenCalledWith("Some content.");
    expect(getTextarea().value).toBe("Some content."); // command consumed
  });
});

describe("App streaming — server-originated finals (C3.4)", () => {
  it("forced final mid-speech appends text, stays streaming, does not shift the FIFO", () => {
    const entry = startContinuous();
    act(() => {
      capturedOnSpeechStart?.();
      capturedOnSpeechFrame?.(new Float32Array(1536));
    });
    mockEmitRecordingState.mockClear();
    // 120 s forced flush arrives while the user is still talking (no client
    // flush — FIFO empty, outstanding 0).
    act(() => {
      entry.cb.onFinal(finalMsg(0, "long dictation part one", { forced: true }));
    });
    expect(getTextarea().value).toBe("Long dictation part one.");
    // No transition away from streaming (no "listening"/"done" emitted).
    expect(mockEmitRecordingState).not.toHaveBeenCalledWith("listening");
    expect(mockEmitRecordingState).not.toHaveBeenCalledWith("done");

    // The utterance's eventual speech end flushes the remainder normally.
    act(() => {
      capturedOnSpeechEnd?.(new Float32Array([0.1]));
      entry.cb.onFinal(finalMsg(1, "part two"));
    });
    expect(getTextarea().value).toBe("Long dictation part one. Part two.");
  });

  it("VAD misfire resets the server utterance and clears live text", () => {
    const entry = startContinuous();
    act(() => {
      capturedOnSpeechStart?.();
      entry.cb.onPartial({ type: "partial", seq: 1, utterance_id: 0, text: "uh" });
    });
    act(() => {
      capturedOnVADMisfire?.();
    });
    expect(entry.session.reset).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("transcript-live")).toBeNull();
    expect(mockEmitRecordingState).toHaveBeenCalledWith("listening");
  });
});

describe("App streaming — degrade ladder (§10)", () => {
  it("degrade replays pending utterances through the one-shot path, then stays degraded", () => {
    const entry = startContinuous();
    // Utterance flushed but not finalized — PCM retained (C10.3).
    speakUtterance(entry, 0);
    expect(mockStreamTranscribeAudio).not.toHaveBeenCalled();

    act(() => {
      entry.cb.onDegrade({ kind: "fatal_error", code: "session_timeout", detail: "x" });
    });
    // Retained utterance replayed.
    expect(mockStreamTranscribeAudio).toHaveBeenCalledTimes(1);

    // Subsequent utterances take the one-shot path directly; no new session.
    act(() => {
      capturedOnSpeechEnd?.(new Float32Array([0.2]));
    });
    expect(mockStreamTranscribeAudio).toHaveBeenCalledTimes(2);
    expect(openStreamSession).toHaveBeenCalledOnce();
  });

  it("a fresh continuous activation tries streaming again after a degraded one", () => {
    startContinuous();
    act(() => {
      sessions[0].cb.onDegrade({ kind: "connect_failed" });
    });
    // Stop (flip the mock before the click so the re-render shows "Record"),
    // then start again.
    mockIsListening = false;
    act(() => {
      fireEvent.click(screen.getByText("Stop"));
    });
    mockIsListening = true;
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    expect(openStreamSession).toHaveBeenCalledTimes(2);
  });

  it("decode_failure surfaces as an error and never falls back (C10.2)", () => {
    const entry = startContinuous();
    speakUtterance(entry, 0);
    act(() => {
      entry.cb.onSurfaceError("decode exploded");
    });
    expect(screen.getByText("decode exploded")).toBeTruthy();
    expect(mockStreamTranscribeAudio).not.toHaveBeenCalled();
    expect(mockEmitRecordingState).toHaveBeenCalledWith("error");
  });
});

describe("App streaming — stop", () => {
  it("stop mid-utterance drains via the server implicit flush, then lands at done", () => {
    const entry = startContinuous();
    act(() => {
      capturedOnSpeechStart?.();
      capturedOnSpeechFrame?.(new Float32Array(1536));
    });
    // User clicks Stop while speaking — VAD pauses without onSpeechEnd.
    act(() => {
      fireEvent.click(screen.getByText("Stop"));
    });
    expect(entry.session.stop).toHaveBeenCalledOnce();

    // Server implicit flush emits the final for the in-flight audio…
    act(() => {
      entry.cb.onFinal(finalMsg(0, "last words"));
    });
    expect(getTextarea().value).toBe("Last words.");
    // …and the stop ack confirms teardown.
    act(() => {
      entry.cb.onStopped?.();
    });
    expect(mockEmitRecordingState).toHaveBeenCalledWith("done");
  });

  it("stop with nothing in flight lands at done on the ack", () => {
    const entry = startContinuous();
    act(() => {
      fireEvent.click(screen.getByText("Stop"));
    });
    expect(entry.session.stop).toHaveBeenCalledOnce();
    act(() => {
      entry.cb.onStopped?.();
    });
    expect(mockEmitRecordingState).toHaveBeenCalledWith("done");
  });
});

describe("App streaming — model selector guard", () => {
  it("selector is disabled during an active session with an explanatory title", async () => {
    render(<App />);
    // Model list loads → enabled select with the current model.
    await waitFor(() => {
      const select = document.querySelector(".model-selector select") as HTMLSelectElement;
      expect(select.disabled).toBe(false);
    });
    // Start continuous — session active → selector disabled, title explains.
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    const select = document.querySelector(".model-selector select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.title).toBe("Stop recording to change models");
  });
});

// ---------------------------------------------------------------------------

describe("App streaming — recovery queue (degrade with dead server)", () => {
  it("queues the utterance non-fatally when the degrade replay fails", () => {
    const entry = startContinuous();
    speakUtterance(entry, 0); // FIFO entry + outstanding flush
    act(() => {
      entry.cb.onDegrade({ kind: "fatal_error", code: "session_timeout", detail: "x" });
    });
    expect(mockStreamTranscribeAudio).toHaveBeenCalledTimes(1); // FIFO replayed
    act(() => {
      streamCalls[0].onConnectionFail();
    });
    expect(screen.getByTestId("recovery-bar").textContent).toContain(
      "1 utterance"
    );
    // No transcript mutation: the textarea either doesn't render yet or is empty.
    const ta = screen.queryByRole("textbox") as HTMLTextAreaElement | null;
    expect(ta?.value ?? "").toBe("");
    expect(mockEmitRecordingState).toHaveBeenCalledWith("listening");
    expect(mockEmitRecordingState).not.toHaveBeenCalledWith("error");
  });

  it("retry lands the utterance text exactly once and clears the bar", () => {
    const entry = startContinuous();
    speakUtterance(entry, 0);
    act(() => {
      entry.cb.onDegrade({ kind: "fatal_error", code: "session_timeout", detail: "x" });
    });
    act(() => {
      streamCalls[0].onConnectionFail();
    });
    act(() => {
      fireEvent.click(screen.getByTestId("recovery-retry"));
    });
    expect(mockStreamTranscribeAudio).toHaveBeenCalledTimes(2);
    expect(streamCalls[1].blob).toBe(streamCalls[0].blob); // same retained WAV
    act(() => {
      streamCalls[1].onComplete({ raw: "hello world", cleaned: "Hello world." });
    });
    expect(getTextarea().value).toBe("Hello world.");
    expect(screen.queryByTestId("recovery-bar")).toBeNull();
  });

  it("healthy-server degrade replays without a bar and without duplication", () => {
    const entry = startContinuous();
    speakUtterance(entry, 0);
    act(() => {
      entry.cb.onDegrade({ kind: "fatal_error", code: "session_timeout", detail: "x" });
    });
    act(() => {
      streamCalls[0].onComplete({ raw: "all good", cleaned: "All good." });
    });
    expect(getTextarea().value).toBe("All good.");
    expect(screen.queryByTestId("recovery-bar")).toBeNull();
  });

  it("bounds the queue at 8 with drop-oldest", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = startContinuous();
    act(() => {
      entry.cb.onDegrade({ kind: "connect_failed" }); // FIFO empty — degrade only
    });
    for (let i = 0; i < 9; i++) {
      act(() => {
        capturedOnSpeechEnd?.(new Float32Array([0.1])); // degraded one-shot path
      });
      act(() => {
        streamCalls[i].onConnectionFail();
      });
    }
    expect(screen.getByTestId("recovery-bar").textContent).toContain(
      "8 utterances"
    );
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("[recovery]"))
    ).toBe(true);
  });

  it("partial retry success re-queues only the failed remainder", () => {
    const entry = startContinuous();
    act(() => {
      entry.cb.onDegrade({ kind: "connect_failed" });
    });
    for (let i = 0; i < 2; i++) {
      act(() => {
        capturedOnSpeechEnd?.(new Float32Array([0.1]));
      });
      act(() => {
        streamCalls[i].onConnectionFail();
      });
    }
    act(() => {
      fireEvent.click(screen.getByTestId("recovery-retry"));
    });
    expect(mockStreamTranscribeAudio).toHaveBeenCalledTimes(4);
    act(() => {
      streamCalls[2].onComplete({ raw: "first", cleaned: "First." });
    });
    act(() => {
      streamCalls[3].onConnectionFail();
    });
    expect(getTextarea().value).toBe("First.");
    expect(screen.getByTestId("recovery-bar").textContent).toContain(
      "1 utterance"
    );
  });

  it("retry completing after the VAD stopped lands at done, not listening", () => {
    const entry = startContinuous();
    act(() => {
      entry.cb.onDegrade({ kind: "connect_failed" });
    });
    act(() => {
      capturedOnSpeechEnd?.(new Float32Array([0.1]));
    });
    act(() => {
      streamCalls[0].onConnectionFail();
    });
    mockIsListening = false; // VAD stopped before the retry resolves
    act(() => {
      fireEvent.click(screen.getByTestId("recovery-retry"));
    });
    mockEmitRecordingState.mockClear();
    act(() => {
      streamCalls[1].onComplete({ raw: "late", cleaned: "Late." });
    });
    expect(getTextarea().value).toBe("Late.");
    expect(mockEmitRecordingState).toHaveBeenLastCalledWith("done");
    expect(mockEmitRecordingState).not.toHaveBeenCalledWith("listening");
  });
});
