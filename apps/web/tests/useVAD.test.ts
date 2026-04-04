import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVAD } from "../src/hooks/useVAD";

// Capture constructor options so tests can invoke callbacks directly.
let capturedOptions: {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
} = {};

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
