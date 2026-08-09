import { useRef, useState, useEffect } from "react";
import { MicVAD } from "@ricky0123/vad-web";

// DEV-ONLY PATH. Vite serves /node_modules/ from the dev server; a production
// bundle has no such route. This repo DOES have a build (`tsc -b && vite
// build`), so a bundle produced by it will fail to load the ONNX runtime.
// Nothing has caught it because the desktop shell is exercised via `cargo tauri
// dev`, which points at the Vite dev server — the production path has never
// been run. Fix is a build-time copy of the two wasm files onnxruntime-web
// actually loads; vendoring is not an option (the dist ships 76 MB of
// variants). Left as-is here deliberately: the desktop shell is frozen, and
// changing the build is out of scope for a fix-forward port.
const ONNX_WASM_BASE_PATH = "/node_modules/onnxruntime-web/dist/";

// VAD tuning passed explicitly to MicVAD.new — the tap's constants below are
// derived from these, so the tap and vad-web can never disagree silently
// (2026-08-02 review finding: relying on library defaults let the tap's
// release threshold drift from vad-web's redemption semantics).
const POS_SPEECH_THRESHOLD = 0.3; // vad-web resets its redemption counter here
const NEG_SPEECH_THRESHOLD = 0.25; // vad-web advances the counter below this
const PRE_SPEECH_PAD_MS = 800;
const REDEMPTION_MS = 1400;
const MIN_SPEECH_MS = 400;
const FRAME_MS = 96; // legacy Silero model: 1536 samples @ 16 kHz

// Pre-roll ring depth: vad-web's own pad holds preSpeechPadMs/96ms = 8 frames
// plus the frame that triggered speech start (its trim runs after the push),
// so 9 frames (864 ms) matches what onSpeechEnd audio will contain.
const RING_FRAMES = Math.floor(PRE_SPEECH_PAD_MS / FRAME_MS) + 1;
// Frames below POS_SPEECH_THRESHOLD during speech are potential
// redemption-window silence and are held, not streamed (protocol C2.6: a
// multi-second silent flush window is Whisper's most reliable hallucination
// trigger). The hold must gate on the POSITIVE threshold: vad-web's
// redemption counter resets only at >= positiveSpeechThreshold, so frames in
// [NEG, POS) are still inside a possible redemption window — releasing on
// them (the pre-2026-08-02 behavior) let ~1.3 s of near-silence reach the
// flush decode. At most TAIL_RELEASE_FRAMES of trailing sub-threshold audio
// reach the wire at speech end.
const TAIL_RELEASE_FRAMES = 2;
// Held-queue bound: gray-zone frames in [NEG, POS) freeze vad-web's
// redemption counter, so a hold can outlast redemptionFrames in sustained
// borderline noise. Past the cap the oldest held frame is streamed (what the
// old code did for every gray frame), keeping memory and added latency
// bounded without opening a gap in a continuing utterance.
const HELD_MAX_FRAMES = Math.floor(REDEMPTION_MS / FRAME_MS) * 2;

export interface UseVADOptions {
  onSpeechStart?: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  /** Per-frame tap (v4.1 streaming). Fires only for speech: the ~864 ms
   * pre-roll ring is replayed immediately after speech start, then every
   * frame until speech end — except held redemption-window silence, which is
   * released in order only if speech resumes. Frames are shared with vad-web's
   * internal buffer: treat as read-only. */
  /**
   * Per-frame tap. The frame is a VIEW into a buffer vad-web reuses: it is
   * valid only for the synchronous duration of this callback. Retaining it —
   * queueing, buffering, deferring a send — delivers whatever the buffer holds
   * later, not what was captured. Copy first if you need to keep it.
   */
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
  // True while startListening is mid-flight; MicVAD.new() is async and two
  // overlapping starts would orphan an instance.
  const startingRef = useRef(false);
  // Set by the unmount cleanup. MicVAD.new() and start() are async, so a
  // component can unmount while one is in flight; without this the resolved
  // instance is adopted AFTER cleanup ran and nothing ever releases it — the
  // microphone and ONNX session stay live for the life of the page.
  const disposedRef = useRef(false);
  // Invalidates in-flight starts. Disposal covers unmount, but a start can also
  // be superseded while its awaits are pending — by stopListening, or by
  // another start. Without this, a MicVAD that resolves after the user pressed
  // Stop is still adopted and started, opening the microphone they just closed.
  const startTokenRef = useRef(0);
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

  // Single owner for destruction, and the only place destroy() is called.
  // pause() may already have released the ONNX session, so destroy() can throw
  // synchronously or reject; both are contained here. An exception thrown out
  // of a React cleanup function is swallowed and skips the rest of the cleanup.
  const releaseVad = async (
    instance: Awaited<ReturnType<typeof MicVAD.new>> | null
  ): Promise<void> => {
    if (!instance) return;
    try {
      await instance.destroy();
    } catch {
      /* already released */
    }
  };

  // Ownership rule, so no instance is ever released twice:
  //   - an instance ASSIGNED to vadRef is owned by this cleanup;
  //   - an instance that resolves before assignment is owned by startListening.
  useEffect(() => {
    // Reset on every setup. React Strict Mode runs setup, cleanup, setup; the
    // cleanup marks disposal, so without this the second setup starts disposed
    // and startListening refuses to run for the life of the component.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const instance = vadRef.current;
      vadRef.current = null;
      void releaseVad(instance); // cleanup cannot be async
    };
  }, []);

  const startListening = async (): Promise<void> => {
    // Re-entrancy guard: MicVAD.new() is async, so two overlapping calls would
    // each build an instance and orphan one — repeated start/stop cycles would
    // leak ONNX runtimes, AudioWorklets and MediaStreams until unmount.
    if (startingRef.current || disposedRef.current) return;
    startingRef.current = true;
    const token = ++startTokenRef.current;
    // Everything past the guard sits inside the try, so the finally below is
    // the single place that clears startingRef — a throw before it would
    // otherwise wedge the hook against every future start.
    try {
      // Take ownership first, then await the release: a later cleanup must
      // never touch a destroyed instance, and the old runtime should be gone
      // before the replacement claims the microphone. releaseVad contains any
      // failure, including the double-release pause() can provoke.
      const previous = vadRef.current;
      vadRef.current = null;
      await releaseVad(previous);
      resetTapState();
      const vad = await MicVAD.new({
        baseAssetPath: "/",
        onnxWASMBasePath: ONNX_WASM_BASE_PATH,
        positiveSpeechThreshold: POS_SPEECH_THRESHOLD,
        negativeSpeechThreshold: NEG_SPEECH_THRESHOLD,
        preSpeechPadMs: PRE_SPEECH_PAD_MS,
        redemptionMs: REDEMPTION_MS,
        minSpeechMs: MIN_SPEECH_MS,
        onFrameProcessed: (probs: { isSpeech: number }, frame: Float32Array) => {
          // Copy on retain: `frame` is a view into a buffer vad-web reuses, and
          // both the ring and the held array replay their contents later. A
          // retained view would deliver whatever the buffer holds by then.
          if (!speakingRef.current) {
            ringRef.current.push(new Float32Array(frame));
            if (ringRef.current.length > RING_FRAMES) ringRef.current.shift();
            return;
          }
          if (probs.isSpeech < POS_SPEECH_THRESHOLD) {
            // Possible redemption window (vad-web's counter is not reset
            // below the positive threshold) — hold, bounded by the cap.
            heldRef.current.push(new Float32Array(frame));
            if (heldRef.current.length > HELD_MAX_FRAMES) {
              const oldest = heldRef.current.shift();
              if (oldest) onSpeechFrameRef.current?.(oldest);
            }
            return;
          }
          // Speech confirmed (redemption counter reset): release held frames
          // in order first, so the server's audio timeline stays contiguous.
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
      // Superseded while constructing — unmounted, stopped, or restarted. Never
      // assigned, so no other path can see it: this one owns it.
      if (disposedRef.current || token !== startTokenRef.current) {
        await releaseVad(vad);
        return;
      }
      vadRef.current = vad;
      await vad.start();
      // Superseded during start(). The instance was already assigned, so it is
      // owned elsewhere — by the cleanup if disposed, or by stopListening,
      // which has paused it. Releasing here would double-destroy; reporting
      // "listening" would contradict the stop the user just asked for.
      if (disposedRef.current || token !== startTokenRef.current) return;
      setError(null);
      setIsListening(true);
    } catch (err) {
      // start() can reject after assignment. If this path still owns the
      // instance, release it — otherwise it lives until unmount holding the
      // microphone. If disposal already took it, the cleanup is the owner.
      const orphan = vadRef.current;
      if (orphan && !disposedRef.current) {
        vadRef.current = null;
        await releaseVad(orphan);
      }
      if (disposedRef.current || token !== startTokenRef.current) return;
      const message =
        err instanceof Error ? err.message : "VAD initialization failed";
      setError(message);
      // A failed start must not leave the UI claiming an active VAD from the
      // previous successful start — there is no instance now.
      setIsListening(false);
    } finally {
      startingRef.current = false;
    }
  };

  const stopListening = (): void => {
    // Invalidate any in-flight start so it cannot resolve into a live VAD
    // after the user has stopped.
    startTokenRef.current += 1;
    if (vadRef.current) {
      // Fire-and-forget by design — the signature stays synchronous because
      // callers drive UI state, not teardown. The rejection is still caught:
      // un-awaited, it would surface as an unhandled promise rejection.
      Promise.resolve(vadRef.current.pause()).catch(() => {
        /* pause on an already-released instance */
      });
      resetTapState();
      setIsListening(false);
    }
  };

  return { startListening, stopListening, isListening, error };
}
