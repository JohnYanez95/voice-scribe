import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { renderHook, act } from "@testing-library/react";
import { useVAD } from "../src/hooks/useVAD";

// Capture constructor options so tests can invoke callbacks directly.
let capturedOptions: {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onFrameProcessed?: (probs: { isSpeech: number }, frame: Float32Array) => void;
  onVADMisfire?: () => void;
} = {};

// Drive helpers — mirror frame-processor.js dispatch order: FrameProcessed
// fires BEFORE SpeechStart for the triggering frame.
const frame = (id: number) => new Float32Array([id]);
const feedSilence = (f: Float32Array) =>
  capturedOptions.onFrameProcessed?.({ isSpeech: 0.05 }, f);
const feedSpeech = (f: Float32Array) =>
  capturedOptions.onFrameProcessed?.({ isSpeech: 0.9 }, f);

const mockVad = {
  start: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: {
    new: vi.fn(async (options: typeof capturedOptions) => {
      capturedOptions = options;
      return mockVad;
    }),
  },
}));

// Import after mock is set up.
import { MicVAD } from "@ricky0123/vad-web";

beforeEach(() => {
  vi.clearAllMocks();
  capturedOptions = {};
});

describe("useVAD", () => {
  it("startListening initializes MicVAD and calls start()", async () => {
    const onSpeechEnd = vi.fn();
    const { result } = renderHook(() => useVAD({ onSpeechEnd }));

    await act(async () => {
      await result.current.startListening();
    });

    expect(MicVAD.new).toHaveBeenCalledOnce();
    expect(mockVad.start).toHaveBeenCalledOnce();
    expect(result.current.isListening).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("onSpeechEnd fires when VAD fires", async () => {
    const onSpeechEnd = vi.fn();
    const { result } = renderHook(() => useVAD({ onSpeechEnd }));

    await act(async () => {
      await result.current.startListening();
    });

    const audio = new Float32Array([0.1, 0.2, 0.3]);
    act(() => {
      capturedOptions.onSpeechEnd?.(audio);
    });

    expect(onSpeechEnd).toHaveBeenCalledWith(audio);
  });

  it("onSpeechStart fires when VAD fires", async () => {
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const { result } = renderHook(() => useVAD({ onSpeechStart, onSpeechEnd }));

    await act(async () => {
      await result.current.startListening();
    });

    act(() => {
      capturedOptions.onSpeechStart?.();
    });

    expect(onSpeechStart).toHaveBeenCalledOnce();
  });

  it("stopListening calls pause() and sets isListening false", async () => {
    const onSpeechEnd = vi.fn();
    const { result } = renderHook(() => useVAD({ onSpeechEnd }));

    await act(async () => {
      await result.current.startListening();
    });

    act(() => {
      result.current.stopListening();
    });

    expect(mockVad.pause).toHaveBeenCalledOnce();
    expect(result.current.isListening).toBe(false);
  });

  it("cleanup on unmount calls destroy()", async () => {
    const onSpeechEnd = vi.fn();
    const { result, unmount } = renderHook(() => useVAD({ onSpeechEnd }));

    await act(async () => {
      await result.current.startListening();
    });

    unmount();

    expect(mockVad.destroy).toHaveBeenCalledOnce();
  });

  it("startListening destroys previous instance before creating a new one", async () => {
    const onSpeechEnd = vi.fn();
    const { result } = renderHook(() => useVAD({ onSpeechEnd }));

    // First start/stop cycle
    await act(async () => {
      await result.current.startListening();
    });
    act(() => {
      result.current.stopListening();
    });

    // destroy() should not have been called yet — only pause()
    expect(mockVad.destroy).not.toHaveBeenCalled();

    // Second startListening — must destroy the paused instance first
    await act(async () => {
      await result.current.startListening();
    });

    expect(mockVad.destroy).toHaveBeenCalledOnce();
  });

  it("onSpeechFrame replays the pre-roll ring exactly once at speech start", async () => {
    const onSpeechEnd = vi.fn();
    const frames: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd, onSpeechFrame: (f) => frames.push(f) })
    );
    await act(async () => {
      await result.current.startListening();
    });

    // 12 silence frames — ring keeps the most recent 9.
    const silence = Array.from({ length: 12 }, (_, i) => frame(i));
    act(() => {
      silence.forEach(feedSilence);
    });
    expect(frames).toHaveLength(0); // nothing streamed while silent

    // Triggering frame: FrameProcessed (silent state → into ring), then
    // SpeechStart replays the ring including it.
    const trigger = frame(100);
    act(() => {
      feedSpeech(trigger); // hook still in silent state: goes into ring
      capturedOptions.onSpeechStart?.();
    });
    // Ring held 9 most recent: frames 4..11 + trigger — replayed once, in order.
    expect(frames.map((f) => f[0])).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 100]);

    // Live speech frames flow directly — no duplicates of the ring.
    act(() => {
      feedSpeech(frame(101));
    });
    expect(frames.map((f) => f[0])).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 100, 101]);
  });

  it("holds sub-threshold frames during speech, releases in order on resume", async () => {
    const onSpeechEnd = vi.fn();
    const frames: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd, onSpeechFrame: (f) => frames.push(f) })
    );
    await act(async () => {
      await result.current.startListening();
    });
    act(() => {
      feedSpeech(frame(1));
      capturedOptions.onSpeechStart?.();
      feedSpeech(frame(2));
      feedSilence(frame(3)); // redemption-window silence: held
      feedSilence(frame(4)); // held
      feedSpeech(frame(5)); // resume: held released in order, then live
    });
    expect(frames.map((f) => f[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it("releases at most a 2-frame tail on speech end, drops the rest", async () => {
    const onSpeechEnd = vi.fn();
    const frames: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd, onSpeechFrame: (f) => frames.push(f) })
    );
    await act(async () => {
      await result.current.startListening();
    });
    act(() => {
      feedSpeech(frame(1));
      capturedOptions.onSpeechStart?.();
      // Redemption tail: 5 held silence frames, then speech end.
      [2, 3, 4, 5, 6].forEach((i) => feedSilence(frame(i)));
      capturedOptions.onSpeechEnd?.(new Float32Array([9]));
    });
    // Frame 1 (ring replay) + first 2 held frames only.
    expect(frames.map((f) => f[0])).toEqual([1, 2, 3]);
    expect(onSpeechEnd).toHaveBeenCalledOnce();
  });

  it("misfire drops all held frames and fires onVADMisfire", async () => {
    const onSpeechEnd = vi.fn();
    const onVADMisfire = vi.fn();
    const frames: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd, onVADMisfire, onSpeechFrame: (f) => frames.push(f) })
    );
    await act(async () => {
      await result.current.startListening();
    });
    act(() => {
      feedSpeech(frame(1));
      capturedOptions.onSpeechStart?.();
      feedSilence(frame(2)); // held
      capturedOptions.onVADMisfire?.();
    });
    expect(frames.map((f) => f[0])).toEqual([1]); // held frame never streamed
    expect(onVADMisfire).toHaveBeenCalledOnce();
    expect(onSpeechEnd).not.toHaveBeenCalled();

    // Post-misfire the tap is back to silent-state ring buffering.
    act(() => {
      feedSilence(frame(3));
    });
    expect(frames).toHaveLength(1);
  });

  it("init failure sets error, does not throw", async () => {
    (MicVAD.new as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("mic permission denied")
    );

    const onSpeechEnd = vi.fn();
    const { result } = renderHook(() => useVAD({ onSpeechEnd }));

    await act(async () => {
      await result.current.startListening();
    });

    expect(result.current.error).toBe("mic permission denied");
    expect(result.current.isListening).toBe(false);
  });
});

// 2026-08-02 field-test fix: the held-frame release must gate on vad-web's
// POSITIVE speech threshold. vad-web's redemption counter resets only at
// >= positiveSpeechThreshold (0.30) and advances only below
// negativeSpeechThreshold (0.25); frames in [0.25, 0.30) freeze it — so a
// gray-zone frame is still inside a possible redemption window, and
// releasing the held queue on it streamed up to ~1.3 s of near-silence into
// the flush decode (Whisper's most reliable hallucination trigger).
describe("useVAD gray-zone gating (2026-08-02)", () => {
  const feedGray = (f: Float32Array) =>
    capturedOptions.onFrameProcessed?.({ isSpeech: 0.27 }, f);

  it("passes explicit VAD tuning to MicVAD.new (no silent default drift)", async () => {
    const { result } = renderHook(() => useVAD({ onSpeechEnd: vi.fn() }));
    await act(async () => {
      await result.current.startListening();
    });
    expect(MicVAD.new).toHaveBeenCalledWith(
      expect.objectContaining({
        positiveSpeechThreshold: 0.3,
        negativeSpeechThreshold: 0.25,
        preSpeechPadMs: 800,
        redemptionMs: 1400,
        minSpeechMs: 400,
      })
    );
  });

  it("holds gray-zone frames during speech; releases only on confirmed speech", async () => {
    const frames: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd: vi.fn(), onSpeechFrame: (f) => frames.push(f) })
    );
    await act(async () => {
      await result.current.startListening();
    });
    act(() => {
      feedSpeech(frame(1));
      capturedOptions.onSpeechStart?.();
      feedGray(frame(2)); // [neg, pos): redemption counter frozen — held
      feedGray(frame(3)); // held
    });
    expect(frames.map((f) => f[0])).toEqual([1]); // gray frames not streamed
    act(() => {
      feedSpeech(frame(4)); // >= pos: counter reset — release in order
    });
    expect(frames.map((f) => f[0])).toEqual([1, 2, 3, 4]);
  });

  it("gray-zone tail at speech end releases at most the 2-frame tail", async () => {
    const frames: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd: vi.fn(), onSpeechFrame: (f) => frames.push(f) })
    );
    await act(async () => {
      await result.current.startListening();
    });
    act(() => {
      feedSpeech(frame(1));
      capturedOptions.onSpeechStart?.();
      [2, 3, 4].forEach((i) => feedGray(frame(i))); // gray run, then VAD ends
      capturedOptions.onSpeechEnd?.(new Float32Array([9]));
    });
    expect(frames.map((f) => f[0])).toEqual([1, 2, 3]);
  });

  it("bounds the held queue: oldest frame streams on overflow past the cap", async () => {
    const frames: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd: vi.fn(), onSpeechFrame: (f) => frames.push(f) })
    );
    await act(async () => {
      await result.current.startListening();
    });
    // cap = floor(1400/96) * 2 = 28 held frames
    act(() => {
      feedSpeech(frame(0));
      capturedOptions.onSpeechStart?.();
      for (let i = 1; i <= 29; i++) feedGray(frame(i));
    });
    // frame(1) — the oldest — spilled when frame(29) exceeded the cap
    expect(frames.map((f) => f[0])).toEqual([0, 1]);
    act(() => {
      feedSpeech(frame(30)); // release remaining 28 in order, then live
    });
    expect(frames.map((f) => f[0])).toEqual([
      0, 1, ...Array.from({ length: 28 }, (_, k) => k + 2), 30,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unmount during an in-flight start (2026-08-09 review). MicVAD.new() and
// start() are async; a component can unmount mid-flight, and the resolved
// instance must not be adopted after cleanup has already run — otherwise the
// microphone and ONNX session stay live for the life of the page.
// ---------------------------------------------------------------------------

describe("unmount during start", () => {
  // Wait for the mocked constructor to actually be entered rather than
  // guessing a microtask count — startListening awaits the previous release
  // first, so the number of ticks before MicVAD.new is an implementation
  // detail these tests must not encode.
  const untilNewCalled = async () => {
    for (let i = 0; i < 50 && vi.mocked(MicVAD.new).mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    // Assert rather than fall through: if the constructor is never entered the
    // test would otherwise fail later on a confusing assertion about destroy.
    expect(vi.mocked(MicVAD.new)).toHaveBeenCalled();
  };

  // Wait on the observable effect instead of a fixed number of microtasks.
  const untilStartCalled = async () => {
    for (let i = 0; i < 50 && mockVad.start.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    expect(mockVad.start).toHaveBeenCalled();
  };

  it("destroys an instance that resolves after unmount, and never starts it", async () => {
    let resolveNew: (v: typeof mockVad) => void = () => {};
    vi.mocked(MicVAD.new).mockImplementationOnce(
      () => new Promise((res) => { resolveNew = res as (v: typeof mockVad) => void; })
    );

    const { result, unmount } = renderHook(() => useVAD({ onSpeechEnd: vi.fn() }));
    let started: Promise<void> = Promise.resolve();
    act(() => { started = result.current.startListening(); });
    await act(async () => { await untilNewCalled(); });

    unmount();                       // cleanup runs while MicVAD.new is pending
    await act(async () => { resolveNew(mockVad); await started; });

    expect(mockVad.destroy).toHaveBeenCalled();
    expect(mockVad.start).not.toHaveBeenCalled();
  });

  it("releases the instance when unmount lands during start()", async () => {
    let resolveStart: () => void = () => {};
    mockVad.start.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveStart = res; })
    );

    const { result, unmount } = renderHook(() => useVAD({ onSpeechEnd: vi.fn() }));
    let started: Promise<void> = Promise.resolve();
    act(() => { started = result.current.startListening(); });
    // Let MicVAD.new resolve and the instance reach vadRef, so the cleanup —
    // not startListening — is the owner when unmount lands.
    await act(async () => { await untilNewCalled(); await untilStartCalled(); });

    unmount();                       // cleanup runs while start() is pending
    await act(async () => { resolveStart(); await started; });

    // Exactly once: the cleanup owns an instance that was already assigned to
    // vadRef. A second destroy from the post-start path is a double release,
    // which is the very thing the guards exist to avoid.
    expect(mockVad.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("strict mode and frame retention", () => {
  it("stays usable after a Strict-Mode setup/cleanup/setup cycle", async () => {
    // Render through an actual StrictMode wrapper rather than approximating it
    // with two mounts: React runs setup, cleanup, setup on the SAME instance,
    // and it is that second setup on a disposed instance that used to wedge
    // the hook.
    const { result } = renderHook(() => useVAD({ onSpeechEnd: vi.fn() }), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    await act(async () => { await result.current.startListening(); });
    expect(result.current.isListening).toBe(true);
  });

  it("copies retained frames so a reused capture buffer cannot rewrite them", async () => {
    const delivered: Float32Array[] = [];
    const { result } = renderHook(() =>
      useVAD({ onSpeechEnd: vi.fn(), onSpeechFrame: (f) => delivered.push(f) })
    );
    await act(async () => { await result.current.startListening(); });

    // Pre-roll: a silent frame is retained in the ring, then vad-web reuses
    // that same buffer before speech onset replays it.
    const reused = new Float32Array([0.75]);
    act(() => { feedSilence(reused); });
    reused[0] = -1;
    act(() => { capturedOptions.onSpeechStart?.(); });

    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered[0][0]).toBe(0.75);
  });
});
