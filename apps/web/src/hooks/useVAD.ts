import { useRef, useState, useEffect } from "react";
import { MicVAD } from "@ricky0123/vad-web";

const ONNX_WASM_BASE_PATH = "/node_modules/onnxruntime-web/dist/";

// Pre-roll ring depth: vad-web's own pad holds preSpeechPadMs/96ms = 8 frames
// plus the frame that triggered speech start (its trim runs after the push),
// so 9 frames (864 ms) matches what onSpeechEnd audio will contain.
const RING_FRAMES = 9;
// Silero's default negativeSpeechThreshold — frames below it during speech
// are redemption-window silence and are held, not streamed (protocol C2.6:
// a multi-second silent flush window is Whisper's most reliable hallucination
// trigger; at most TAIL_RELEASE_FRAMES of trailing silence reach the wire).
const NEG_SPEECH_THRESHOLD = 0.25;
const TAIL_RELEASE_FRAMES = 2;

export interface UseVADOptions {
  onSpeechStart?: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  /** Per-frame tap (v4.1 streaming). Fires only for speech: the ~864 ms
   * pre-roll ring is replayed immediately after speech start, then every
   * frame until speech end — except held redemption-window silence, which is
   * released in order only if speech resumes. Frames are shared with vad-web's
   * internal buffer: treat as read-only. */
  onSpeechFrame?: (frame: Float32Array) => void;
  /** Speech segment shorter than minSpeechMs — pre-roll frames were already
   * streamed; the streaming client must reset the server utterance. */
  onVADMisfire?: () => void;
}

export interface UseVADResult {
  startListening: () => Promise<void>;
  stopListening: () => void;
  isListening: boolean;
  error: string | null;
}

export function useVAD(options: UseVADOptions): UseVADResult {
  const vadRef = useRef<Awaited<ReturnType<typeof MicVAD.new>> | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable callback refs — updated on every render so callbacks inside
  // the VAD closure always see the current version without stale captures.
  const onSpeechStartRef = useRef(options.onSpeechStart);
  const onSpeechEndRef = useRef(options.onSpeechEnd);
  const onSpeechFrameRef = useRef(options.onSpeechFrame);
  const onVADMisfireRef = useRef(options.onVADMisfire);
  useEffect(() => {
    onSpeechStartRef.current = options.onSpeechStart;
    onSpeechEndRef.current = options.onSpeechEnd;
    onSpeechFrameRef.current = options.onSpeechFrame;
    onVADMisfireRef.current = options.onVADMisfire;
  });

  // Frame-tap state. Refs, not state: frames arrive every 96 ms and must not
  // rerender. onFrameProcessed dispatches BEFORE onSpeechStart for the
  // triggering frame (frame-processor.js), so that frame is in the ring when
  // the ring is replayed — delivered exactly once.
  const ringRef = useRef<Float32Array[]>([]);
  const heldRef = useRef<Float32Array[]>([]);
  const speakingRef = useRef(false);

  const resetTapState = () => {
    ringRef.current = [];
    heldRef.current = [];
    speakingRef.current = false;
  };

  // Destroy VAD instance on unmount.
  useEffect(() => {
    return () => {
      vadRef.current?.destroy();
    };
  }, []);

  const startListening = async (): Promise<void> => {
    // Destroy any previous paused instance before creating a new one.
    // Without this, repeated start/stop cycles orphan MicVAD instances
    // (ONNX runtime + AudioWorklet + MediaStream) until component unmount.
    // pause() internally releases the ONNX session; destroy() may then
    // attempt a second release and throw. Suppress — we're replacing the
    // instance regardless.
    try { vadRef.current?.destroy(); } catch (_) {}
    resetTapState();
    try {
      const vad = await MicVAD.new({
        baseAssetPath: "/",
        onnxWASMBasePath: ONNX_WASM_BASE_PATH,
        onFrameProcessed: (probs: { isSpeech: number }, frame: Float32Array) => {
          if (!speakingRef.current) {
            ringRef.current.push(frame);
            if (ringRef.current.length > RING_FRAMES) ringRef.current.shift();
            return;
          }
          if (probs.isSpeech < NEG_SPEECH_THRESHOLD) {
            heldRef.current.push(frame);
            return;
          }
          // Speech resumed: release held silence in order first, so the
          // server's audio timeline stays contiguous.
          for (const held of heldRef.current) onSpeechFrameRef.current?.(held);
          heldRef.current = [];
          onSpeechFrameRef.current?.(frame);
        },
        onSpeechStart: () => {
          // Replay the pre-roll ring (includes the triggering frame), then
          // switch to live emission.
          for (const frame of ringRef.current) onSpeechFrameRef.current?.(frame);
          ringRef.current = [];
          heldRef.current = [];
          speakingRef.current = true;
          onSpeechStartRef.current?.();
        },
        onSpeechEnd: (audio: Float32Array) => {
          // Release a short trailing tail; drop the rest of the redemption
          // silence (never streamed — C2.6).
          const tail = heldRef.current.slice(0, TAIL_RELEASE_FRAMES);
          for (const frame of tail) onSpeechFrameRef.current?.(frame);
          resetTapState();
          onSpeechEndRef.current(audio);
        },
        onVADMisfire: () => {
          resetTapState();
          onVADMisfireRef.current?.();
        },
      });
      vadRef.current = vad;
      await vad.start();
      setIsListening(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "VAD initialization failed";
      setError(message);
    }
  };

  const stopListening = (): void => {
    if (vadRef.current) {
      vadRef.current.pause();
      resetTapState();
      setIsListening(false);
    }
  };

  return { startListening, stopListening, isListening, error };
}
