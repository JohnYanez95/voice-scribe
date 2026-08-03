import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelSelector } from "../features/model-selector/ModelSelector";
import { Recorder } from "../features/recorder/Recorder";
import { Settings } from "../features/settings/Settings";
import { Transcript } from "../features/transcript/Transcript";
import { useRecorder } from "../hooks/useRecorder";
import { useHotkeys } from "../hooks/useHotkeys";
import { useVAD } from "../hooks/useVAD";
import { encodeWav } from "../utils/audio";
import { detectVoiceCommand } from "../utils/voiceCommands";
import { streamTranscribeAudio, transcribeAudio } from "../services/api";
import { openStreamSession } from "../services/streamSession";
import type { StreamSession } from "../services/streamSession";
import { initAudio, playCopySound, playClearSound, setAudioMuted } from "../services/audio";
import { isDesktop, writeClipboard, emitRecordingState } from "../services/platform";
import { exportWireLog, recordWireMarker, wireDebugEnabled } from "../services/wireDebug";
import type { RecordingMode, RecordingState, WsStreamFinalMessage } from "../types";

const PARAGRAPH_BREAK_MS = 3000;
// C10.3 retention bound: flushed-but-unfinalized utterance PCM (realistic
// depth 0–1; the cap only matters if the server stops emitting finals).
const MAX_PENDING_UTTERANCES = 8;
// C1.6: rotate the session before the server's 1800 s ceiling, at an
// inter-utterance boundary — invisible to the user (protocol C3.8 note).
const SESSION_ROTATE_S = 1500;

export function App() {
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (document.documentElement.getAttribute("data-theme") as "dark" | "light") ?? "dark"
  );

  const handleToggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("voice-scribe-theme", next);
    setTheme(next);
  }, [theme]);

  const [state, setStateRaw] = useState<RecordingState>("idle");

  // Wrapper that emits state to Rust for tray tooltip sync.
  // All state transitions go through this — not setStateRaw directly.
  const setState = useCallback((next: RecordingState) => {
    setStateRaw(next);
    emitRecordingState(next);
  }, []);
  // In Tauri, the sidecar needs time to start. Gate recording until the Rust
  // side emits "backend-ready". In the browser, the backend is already running
  // (or will surface errors at transcription time) — no gate.
  const [backendReady, setBackendReady] = useState(!isDesktop());
  const [transcript, setTranscript] = useState("");
  const [rawTranscript, setRawTranscript] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSwapping, setModelSwapping] = useState(false);
  const [showRawComparison, setShowRawComparison] = useState<boolean>(
    () => localStorage.getItem("voice-scribe-show-comparison") === "true"
  );
  const [recordingMode, setRecordingMode] = useState<RecordingMode>(
    () =>
      (localStorage.getItem("voice-scribe-recording-mode") as RecordingMode) ??
      "push-to-talk"
  );
  const [audioMuted, setAudioMutedState] = useState<boolean>(
    () => localStorage.getItem("voice-scribe-audio-muted") === "true"
  );
  const [maxDuration, setMaxDurationState] = useState<number>(
    () => Number(localStorage.getItem("voice-scribe-max-duration")) || 60
  );

  const wsCleanupSetRef = useRef<Set<() => void>>(new Set());
  const durationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRequestedRef = useRef(false);
  const lastSegmentTimestampRef = useRef<number>(0);

  // --- Streaming session state (v4.1, continuous mode only) ---
  const streamSessionRef = useRef<StreamSession | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  // Permanent per continuous activation (C10.1); reset on each Start.
  const streamDegradedRef = useRef(false);
  // C10.3 FIFO: flushed-but-unfinalized utterances, replayed on degrade.
  const pendingUtterancesRef = useRef<Array<{ audio: Float32Array; speechEndTime: number }>>([]);
  // Finals shift the FIFO only while a client flush is outstanding —
  // unsolicited finals (forced 120 s flush, stop/ceiling flush) must not
  // pop someone else's retained PCM.
  const outstandingFlushesRef = useRef(0);
  const speakingRef = useRef(false);
  const [liveCommitted, setLiveCommitted] = useState("");
  const [liveTail, setLiveTail] = useState("");

  // Stable ref to current transcript so "copy" inside
  // triggerTranscription's closure always reads the latest value.
  const transcriptRef = useRef(transcript);
  useEffect(() => { transcriptRef.current = transcript; });

  // Current recording state for async stream callbacks (avoids stale closures).
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });

  const handleSetShowRawComparison = useCallback((show: boolean) => {
    localStorage.setItem("voice-scribe-show-comparison", String(show));
    setShowRawComparison(show);
  }, []);

  const handleSetRecordingMode = useCallback((mode: RecordingMode) => {
    localStorage.setItem("voice-scribe-recording-mode", mode);
    setRecordingMode(mode);
  }, []);

  const handleSetAudioMuted = useCallback((muted: boolean) => {
    localStorage.setItem("voice-scribe-audio-muted", String(muted));
    setAudioMuted(muted);
    setAudioMutedState(muted);
  }, []);

  const handleSetMaxDuration = useCallback((seconds: number) => {
    // Upper bound matches MAX_AUDIO_SECONDS in apps/api/app/config.py.
    // Raising this requires a matching WebSocket cap on the backend.
    const clamped = Math.max(5, Math.min(60, seconds));
    localStorage.setItem("voice-scribe-max-duration", String(clamped));
    setMaxDurationState(clamped);
  }, []);

  // Initialize audio: sync mute state then preload buffers.
  // Order matters — set mute before preload so module state is consistent.
  useEffect(() => {
    const stored = localStorage.getItem("voice-scribe-audio-muted") === "true";
    setAudioMuted(stored);
    initAudio();
  }, []);

  const {
    startRecording,
    stopRecording,
    audioBlob,
    isRecording,
    error: recorderError,
  } = useRecorder();

  // Handle recorder errors
  useEffect(() => {
    if (recorderError) {
      setError(recorderError);
      setState("error");
    }
  }, [recorderError]);

  // Listen for sidecar readiness in Tauri context
  useEffect(() => {
    if (!isDesktop()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauriEvent = (window as any).__TAURI__?.event;
    if (!tauriEvent) return;
    const unlisten = tauriEvent.listen(
      "backend-ready",
      () => setBackendReady(true)
    );
    return () => {
      unlisten.then((fn: () => void) => fn());
    };
  }, []);

  // Cleanup WebSocket on unmount
  useEffect(() => () => {
    wsCleanupSetRef.current.forEach((fn) => fn());
    wsCleanupSetRef.current.clear();
  }, []);

  /**
   * Segment completion — shared verbatim by the one-shot onComplete and the
   * streaming onFinal so the two paths cannot drift: voice-command
   * interception first, then transcript accumulation with the speech-end-gap
   * separator, timestamp update, and the state transition.
   * stateTransition "none" is the forced-final-mid-speech case (C3.4): text
   * appends but the UI stays in "streaming" — the user is still talking.
   */
  const completeSegment = useCallback(
    (
      result: { raw: string; cleaned: string },
      speechEndTime: number | undefined,
      append: boolean,
      stateTransition: "auto" | "none" = "auto"
    ) => {
      const command = detectVoiceCommand(result.cleaned);

      if (command) {
        // Entire segment is a command — consume it, do not add to transcript.
        switch (command) {
          case "copy":
            if (transcriptRef.current) {
              writeClipboard(transcriptRef.current)
                .then(() => playCopySound())
                .catch((err) => {
                  console.error("[copy command] clipboard write failed:", err);
                  // No sound on failure — hard requirement
                });
            }
            break;
          case "clear":
            // Clear buffer directly — do NOT call handleClearTranscript (sets idle).
            // The transition block below owns RecordingState; mixing setState calls
            // within the same callback risks non-deterministic ordering in React batching.
            playClearSound().catch((err) => {
              console.error("[clear command] audio playback failed:", err);
            });
            setTranscript("");
            setRawTranscript("");

            break;
        }
      } else {
        // Normal transcript update — existing accumulation logic, unchanged.
        setRawTranscript(result.raw);
        if (append) {
          // Measure elapsed time between speech-end events, not server
          // completions. speechEndTime is captured at onSpeechEnd before
          // inference starts, so GPU latency is excluded from the gap.
          const segmentTime = speechEndTime ?? Date.now();
          const elapsed = segmentTime - lastSegmentTimestampRef.current;
          const separator =
            lastSegmentTimestampRef.current === 0
              ? ""                        // first segment — no prefix
              : elapsed > PARAGRAPH_BREAK_MS
                ? "\n\n"                  // long pause — paragraph break
                : " ";                    // short pause — space
          setTranscript((prev) =>
            prev ? prev + separator + result.cleaned : result.cleaned
          );
        } else {
          setTranscript(result.cleaned);
        }
      }

      // Timestamp update runs after both command and non-command paths.
      // Stores the speech-end time of this segment so the next segment's
      // elapsed comparison measures the gap between when the user spoke,
      // not between when the GPU finished.
      lastSegmentTimestampRef.current = speechEndTime ?? Date.now();

      if (stateTransition === "none") return;

      // State transition — unchanged. Runs for both commands and normal segments.
      if (append && stopRequestedRef.current) {
        stopRequestedRef.current = false;
        setState("done"); // drain complete — explicit stop
      } else if (append) {
        setState("listening"); // normal cycle — mic stays open
      } else {
        setState("done"); // push-to-talk always lands at done
      }
    },
    [setState]
  );

  /**
   * Core transcription trigger — imperative, called directly from both the
   * push-to-talk effect (append=false) and the VAD onSpeechEnd callback
   * (append=true). The two paths are kept separate by design:
   *
   *   Push-to-talk (append=false): cancels previous in-flight connection,
   *     clears transcript, falls back to HTTP POST on connection failure.
   *   Continuous  (append=true):  does NOT cancel previous connection (lets
   *     concurrent segments complete and append), no HTTP fallback.
   */
  const triggerTranscription = useCallback(
    (blob: Blob, append: boolean, speechEndTime?: number) => {
      if (!append) {
        // Push-to-talk: cancel all in-flight connections
        wsCleanupSetRef.current.forEach((fn) => fn());
        wsCleanupSetRef.current.clear();
      }
      // Continuous (append=true): leave previous segment in-flight

      setState("processing");
      setError("");
      if (!append) {
        setTranscript("");
        setRawTranscript("");

      }

      // Deregister hook — assigned after streamTranscribeAudio returns,
      // called by async callbacks to remove completed connections from the set.
      let deregister: (() => void) | undefined;

      const cleanup = streamTranscribeAudio(
        blob,
        (text) => {
          // Push-to-talk only: stream partial text while inference runs.
          // Continuous skips segment updates — onComplete appends the final
          // cleaned text. Applying both would duplicate every utterance.
          if (!append) {
            setTranscript((prev) => (prev ? prev + " " + text : text));
          }
        },
        (result) => {
          deregister?.(); // Connection completed — remove from cleanup set
          completeSegment(result, speechEndTime, append);
        },
        () => {
          deregister?.(); // Connection failed — remove from cleanup set
          // Connection-level failure (WebSocket never established or dropped)
          if (!append) {
            // Push-to-talk: server may still serve HTTP — fall back
            transcribeAudio(blob)
              .then((result) => {
                setRawTranscript(result.raw);
                setTranscript(result.cleaned);
                setState("done");
              })
              .catch((err) => {
                const message =
                  err instanceof Error ? err.message : "Transcription failed";
                setError(message);
                setState("error");
              });
          } else {
            // Continuous: same error will recur on retry — surface immediately
            setError("Transcription connection failed");
            setState("error");
          }
        },
        (detail) => {
          deregister?.(); // Connection errored — remove from cleanup set
          // Application-level failure — inference or transcode error
          setError(detail);
          setState("error");
        }
      );

      wsCleanupSetRef.current.add(cleanup);
      deregister = () => wsCleanupSetRef.current.delete(cleanup);
    },
    [recordingMode, completeSegment] // eslint-disable-line react-hooks/exhaustive-deps
    // recordingMode is not read inside this callback but kept in deps so
    // the ref below always holds the version matching the current mode.
  );

  // Keep a stable ref so the push-to-talk effect can call the current version
  // of triggerTranscription without listing it as an effect dependency
  // (which would cause the effect to re-fire on mode changes).
  const triggerTranscriptionRef = useRef(triggerTranscription);
  useEffect(() => {
    triggerTranscriptionRef.current = triggerTranscription;
  });

  // --- Streaming session lifecycle (v4.1, continuous mode) -----------------

  /** Close the session and drop its unmount-cleanup registration. */
  const discardStreamSession = useCallback(() => {
    if (streamCleanupRef.current) {
      wsCleanupSetRef.current.delete(streamCleanupRef.current);
      streamCleanupRef.current = null;
    }
    streamSessionRef.current?.close();
    streamSessionRef.current = null;
  }, []);

  const clearLiveText = useCallback(() => {
    setLiveCommitted("");
    setLiveTail("");
  }, []);

  /** §10 degrade: permanent for this continuous activation. Replays the
   * retained FIFO through the existing one-shot path — completions arrive in
   * server order (single GPU), same as today's concurrent VAD segments. Must
   * be safe before streamSessionRef is assigned (the module may degrade
   * synchronously): touches only flags, never the session object. */
  const degradeStream = useCallback(() => {
    streamDegradedRef.current = true;
    discardStreamSession();
    clearLiveText();
    outstandingFlushesRef.current = 0;
    const pending = pendingUtterancesRef.current;
    pendingUtterancesRef.current = [];
    for (const entry of pending) {
      triggerTranscriptionRef.current(
        encodeWav(entry.audio, 16000),
        true,
        entry.speechEndTime
      );
    }
    if (pending.length === 0 && stateRef.current === "streaming") {
      // Nothing to replay: fall back to listening; the interrupted
      // utterance's eventual onSpeechEnd takes the degraded one-shot branch.
      setState("listening");
    }
  }, [discardStreamSession, clearLiveText, setState]);

  const handleStreamFinal = useCallback(
    (msg: WsStreamFinalMessage) => {
      // PCM release (C4.4) is decoupled from segment completion: only a
      // final answering a client flush shifts the FIFO — unsolicited finals
      // (forced 120 s flush, stop/ceiling flush) complete with "now".
      let speechEndTime: number | undefined;
      if (outstandingFlushesRef.current > 0) {
        outstandingFlushesRef.current -= 1;
        speechEndTime = pendingUtterancesRef.current.shift()?.speechEndTime;
      }
      clearLiveText();
      // C3.4: a forced final while the user is still talking appends its text
      // but must not leave "streaming" or run the stop-drain transition.
      const midSpeech = msg.forced && speakingRef.current;
      if (msg.raw || msg.cleaned) {
        completeSegment(
          { raw: msg.raw, cleaned: msg.cleaned },
          speechEndTime,
          true,
          midSpeech ? "none" : "auto"
        );
      } else if (!midSpeech) {
        // Empty flush tail (e.g. stop with nothing uncommitted): transition only.
        if (stopRequestedRef.current) {
          stopRequestedRef.current = false;
          setState("done");
        } else {
          setState("listening");
        }
      }
      // C1.6: rotate at an idle inter-utterance boundary, never mid-speech.
      const session = streamSessionRef.current;
      if (
        session &&
        !midSpeech &&
        !speakingRef.current &&
        outstandingFlushesRef.current === 0 &&
        !stopRequestedRef.current &&
        session.age() > SESSION_ROTATE_S
      ) {
        discardStreamSession();
        openStreamRef.current?.();
      }
    },
    [completeSegment, clearLiveText, discardStreamSession, setState]
  );

  const openStream = useCallback(() => {
    const session = openStreamSession(
      {},
      {
        onPartial: (msg) => setLiveTail(msg.text),
        onCommitted: (msg) => {
          // Single-space join of append-only deltas (raw text; replaced by
          // final.cleaned at completion — C5.4 guarantees words match).
          setLiveCommitted((prev) => (prev ? prev + " " + msg.text : msg.text));
          setLiveTail("");
        },
        onFinal: handleStreamFinal,
        onDegrade: () => degradeStream(),
        onSurfaceError: (detail) => {
          // decode_failure only (C10.2): surface, never fall back.
          discardStreamSession();
          clearLiveText();
          setError(detail);
          setState("error");
        },
        onStopped: () => {
          discardStreamSession();
          clearLiveText();
          if (stopRequestedRef.current) {
            stopRequestedRef.current = false;
            setState("done");
          }
        },
      }
    );
    // The module degrades synchronously on constructor-time failure — only
    // register a live session.
    if (session.state !== "closed") {
      streamSessionRef.current = session;
      const cleanup = () => session.close();
      streamCleanupRef.current = cleanup;
      wsCleanupSetRef.current.add(cleanup);
    }
  }, [handleStreamFinal, degradeStream, discardStreamSession, clearLiveText, setState]);

  // Rotation needs openStream from inside handleStreamFinal — break the
  // definition cycle with a ref.
  const openStreamRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    openStreamRef.current = openStream;
  });

  /** Streaming is live when the session is open and this activation has not
   * degraded — everything else takes the pre-v4.1 one-shot branch. */
  const streamingActive = () =>
    streamSessionRef.current?.state === "open" && !streamDegradedRef.current;

  const { startListening, stopListening, isListening, error: vadError } =
    useVAD({
      onSpeechStart: () => {
        recordWireMarker("speech_start");
        speakingRef.current = true;
        if (streamingActive()) setState("streaming");
      },
      onSpeechFrame: (frame) => {
        // C2.6 gating lives in the hook — only speech (plus pre-roll and
        // held-tail release) ever reaches this callback.
        if (streamingActive()) streamSessionRef.current?.sendAudio(frame);
      },
      onVADMisfire: () => {
        recordWireMarker("vad_misfire");
        speakingRef.current = false;
        if (streamingActive()) {
          // Pre-roll frames already streamed — destructive reset (C3.6);
          // misfires push no FIFO entry, so final matching is unaffected.
          streamSessionRef.current?.reset();
          clearLiveText();
          setState("listening");
        }
      },
      onSpeechEnd: (audio) => {
        recordWireMarker("speech_end");
        speakingRef.current = false;
        const speechEndTime = Date.now();
        if (streamingActive()) {
          streamSessionRef.current?.flush();
          pendingUtterancesRef.current.push({ audio, speechEndTime });
          if (pendingUtterancesRef.current.length > MAX_PENDING_UTTERANCES) {
            console.error(
              "stream: pending-utterance FIFO over C10.3 bound — dropping oldest"
            );
            pendingUtterancesRef.current.shift();
            outstandingFlushesRef.current -= 1;
          }
          outstandingFlushesRef.current += 1;
        } else {
          const blob = encodeWav(audio, 16000);
          triggerTranscription(blob, true, speechEndTime);
        }
      },
    });

  // Handle VAD errors
  useEffect(() => {
    if (vadError) {
      setError(vadError);
      setState("error");
    }
  }, [vadError]);

  // Handle completed push-to-talk recording.
  // Continuous mode produces blobs via VAD onSpeechEnd — not via useRecorder —
  // so this effect is push-to-talk only and must not re-fire on mode changes.
  useEffect(() => {
    if (!audioBlob) return;
    triggerTranscriptionRef.current(audioBlob, false);
  }, [audioBlob]);

  const handleToggle = useCallback(async () => {
    // Clear any existing duration timer
    if (durationTimerRef.current) {
      clearTimeout(durationTimerRef.current);
      durationTimerRef.current = null;
    }

    if (recordingMode === "continuous") {
      if (isListening) {
        const session = streamSessionRef.current;
        if (session && session.state === "open" && !streamDegradedRef.current) {
          // Streaming stop: the server's implicit flush (C3.5) emits any
          // pending final first; stopRequestedRef owns the drain, onStopped
          // confirms → done.
          stopRequestedRef.current = true;
          session.stop();
        } else if (state === "processing" || state === "streaming") {
          // Degraded / no session: if a segment is in-flight, flag for drain
          session?.close();
          discardStreamSession();
          stopRequestedRef.current = true;
        } else {
          discardStreamSession();
          setState("done");
        }
        stopListening();
      } else {
        // Fresh activation: a new session tries streaming again even after a
        // degraded previous activation (C10.1 — degrade is per session).
        streamDegradedRef.current = false;
        pendingUtterancesRef.current = [];
        outstandingFlushesRef.current = 0;
        speakingRef.current = false;
        clearLiveText();
        setState("listening");
        setError("");
        openStream();
        await startListening();
      }
    } else {
      // Push-to-talk
      if (isRecording) {
        stopRecording();
      } else {
        setState("recording");
        setError("");
        await startRecording();
        // Auto-stop after maxDuration seconds
        durationTimerRef.current = setTimeout(() => {
          durationTimerRef.current = null;
          stopRecording();
        }, maxDuration * 1000);
      }
    }
  }, [
    recordingMode,
    isListening,
    isRecording,
    state,
    maxDuration,
    startListening,
    stopListening,
    startRecording,
    stopRecording,
    openStream,
    discardStreamSession,
    clearLiveText,
  ]);

  // Debounce ref — absorbs rapid-fire toggles from tray menu clicks or
  // key repeats. 200ms window prevents start+immediate-stop on the same
  // user gesture.
  const lastToggleRef = useRef(0);

  const handleToggleRecording = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleRef.current < 200) return;
    lastToggleRef.current = now;
    if (settingsOpen) return;
    // Push-to-talk: block during processing (can't start new recording)
    // Continuous + isListening: allow during processing (drain-then-done stop)
    if (state === "processing" && !isListening) return;
    handleToggle();
  }, [settingsOpen, state, isListening, handleToggle]);

  const handleCopyTranscript = useCallback(() => {
    if (transcript) {
      writeClipboard(transcript)
        .then(() => playCopySound())
        .catch((err) => {
          console.error("[hotkey] clipboard write failed:", err);
        });
    }
  }, [transcript]);

  const handleClearTranscript = useCallback(() => {
    playClearSound().catch((err) => {
      console.error("[hotkey] clear sound failed:", err);
    });
    setTranscript("");
    setRawTranscript("");
    setState("idle");
  }, []);

  const handleToggleSettings = useCallback(() => {
    if (
      state === "recording" ||
      state === "listening" ||
      state === "streaming" ||
      state === "processing"
    )
      return;
    setSettingsOpen((prev) => !prev);
  }, [state]);

  // Browser hotkeys — active in both browser and desktop modes.
  // In desktop mode (WebKitGTK), Ctrl+Shift+Space and Ctrl+Shift+S are
  // intercepted at the native level and do not reliably reach JS. Y and X
  // work. See useHotkeys.ts for the full list of WebKitGTK interceptions.
  const hotkeyHandlers = useMemo(
    () => ({
      onToggleRecording: handleToggleRecording,
      onCopyTranscript: handleCopyTranscript,
      onClearTranscript: handleClearTranscript,
      onToggleSettings: handleToggleSettings,
    }),
    [
      handleToggleRecording,
      handleCopyTranscript,
      handleClearTranscript,
      handleToggleSettings,
    ]
  );

  useHotkeys(hotkeyHandlers);

  // Listen for tray menu and global hotkey events from the Rust process.
  // "tray-toggle-recording" is emitted by both the tray menu item and the
  // global shortcut handler — single event, single handler.
  useEffect(() => {
    if (!isDesktop()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauriEvent = (window as any).__TAURI__?.event;
    if (!tauriEvent) return;

    const unlistenToggle = tauriEvent.listen(
      "tray-toggle-recording",
      () => handleToggleRecording()
    );
    const unlistenSettings = tauriEvent.listen(
      "tray-toggle-settings",
      () => handleToggleSettings()
    );
    const unlistenShortcutFail = tauriEvent.listen(
      "shortcut-registration-failed",
      (event: { payload: string }) => {
        setError(event.payload);
      }
    );

    return () => {
      unlistenToggle.then((fn: () => void) => fn());
      unlistenSettings.then((fn: () => void) => fn());
      unlistenShortcutFail.then((fn: () => void) => fn());
    };
  }, [handleToggleRecording, handleToggleSettings]);

  // In continuous mode, the user can click Stop while processing (drain-then-done).
  // isListening=true means the VAD is running — Stop is a valid action.
  // Push-to-talk processing blocks all recording actions.
  const isDisabled =
    (state === "processing" && !isListening) || modelSwapping || !backendReady;
  const isActiveSession =
    state === "recording" ||
    state === "listening" ||
    state === "streaming" ||
    state === "processing";

  return (
    <div className="app">
      <div className="toolbar-top">
        <ModelSelector
          backendReady={backendReady}
          onSwapStateChange={setModelSwapping}
          sessionActive={isActiveSession}
        />
        <h1>Voice Scribe</h1>
        <Recorder
          state={state}
          isRecording={isRecording || isListening}
          onToggle={handleToggle}
          recorderError={recorderError}
          disabled={isDisabled}
          backendReady={backendReady}
        />
        <button
          className="theme-btn"
          onClick={handleToggleTheme}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "\u2600" : "\u263E"}
        </button>
        <button
          className="settings-btn"
          onClick={() => setSettingsOpen((prev) => !prev)}
          aria-label="Settings"
        >
          &#9881;
        </button>
      </div>
      <div className="main-area">
        {error && <p className="error">{error}</p>}
        <Transcript
          text={transcript}
          rawText={rawTranscript}
          isLoading={state === "processing"}
          onTextChange={setTranscript}
          showComparison={showRawComparison}
          isRecordingActive={isActiveSession}
          liveCommitted={liveCommitted}
          liveTail={liveTail}
        />
      </div>
      <div className="toolbar-bottom">
        {wireDebugEnabled() && (
          <button
            className="wire-debug-btn"
            onClick={exportWireLog}
            title="Developer mode (?debug=stream): downloads the in-memory wire log. The file contains transcript text — it is never persisted or transmitted unless you export it."
          >
            Export wire log
          </button>
        )}
        <div className="hotkey-hints">
          {isDesktop()
            ? "Ctrl+Shift+Y: Copy \u00A0|\u00A0 Ctrl+Shift+X: Clear"
            : "Ctrl+Shift+Space: Record \u00A0|\u00A0 Ctrl+Shift+Y: Copy \u00A0|\u00A0 Ctrl+Shift+X: Clear \u00A0|\u00A0 Ctrl+Shift+S: Settings"
          }
        </div>
      </div>
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        showRawComparison={showRawComparison}
        onShowRawComparisonChange={handleSetShowRawComparison}
        recordingMode={recordingMode}
        onRecordingModeChange={handleSetRecordingMode}
        audioMuted={audioMuted}
        onAudioMutedChange={handleSetAudioMuted}
        maxDuration={maxDuration}
        onMaxDurationChange={handleSetMaxDuration}
        isActive={isActiveSession}
      />
    </div>
  );
}
