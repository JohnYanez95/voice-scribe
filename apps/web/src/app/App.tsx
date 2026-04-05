import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Recorder } from "../features/recorder/Recorder";
import { Settings } from "../features/settings/Settings";
import { Transcript } from "../features/transcript/Transcript";
import { useRecorder } from "../hooks/useRecorder";
import { useHotkeys } from "../hooks/useHotkeys";
import { useVAD } from "../hooks/useVAD";
import { encodeWav } from "../utils/audio";
import { detectVoiceCommand } from "../utils/voiceCommands";
import { streamTranscribeAudio, transcribeAudio } from "../services/api";
import type { RecordingMode, RecordingState } from "../types";

const PARAGRAPH_BREAK_MS = 3000;

// Runtime platform detection — no @tauri-apps/api import needed (deferred to v3.1).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isDesktop = typeof (window as any).__TAURI__ !== "undefined";

export function App() {
  const [state, setState] = useState<RecordingState>("idle");
  // In Tauri, the sidecar needs time to start. Gate recording until the Rust
  // side emits "backend-ready". In the browser, the backend is already running
  // (or will surface errors at transcription time) — no gate.
  const [backendReady, setBackendReady] = useState(!isDesktop);
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

  const wsCleanupSetRef = useRef<Set<() => void>>(new Set());
  const stopRequestedRef = useRef(false);
  const lastSegmentTimestampRef = useRef<number>(0);

  // Stable ref to current transcript so "copy" inside
  // triggerTranscription's closure always reads the latest value.
  const transcriptRef = useRef(transcript);
  useEffect(() => { transcriptRef.current = transcript; });

  const handleSetShowRawComparison = useCallback((show: boolean) => {
    localStorage.setItem("voice-scribe-show-comparison", String(show));
    setShowRawComparison(show);
  }, []);

  const handleSetRecordingMode = useCallback((mode: RecordingMode) => {
    localStorage.setItem("voice-scribe-recording-mode", mode);
    setRecordingMode(mode);
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
    if (!isDesktop) return;
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
          const command = detectVoiceCommand(result.cleaned);

          if (command) {
            // Entire segment is a command — consume it, do not add to transcript.
            switch (command) {
              case "copy":
                if (transcriptRef.current) {
                  navigator.clipboard.writeText(transcriptRef.current).catch(() => {});
                }
                break;
              case "clear":
                // Clear buffer directly — do NOT call handleClearTranscript (sets idle).
                // The transition block below owns RecordingState; mixing setState calls
                // within the same callback risks non-deterministic ordering in React batching.
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
                lastSegmentTimestampRef.current > 0 &&
                elapsed > PARAGRAPH_BREAK_MS
                  ? "\n\n"
                  : "";
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
    [recordingMode] // eslint-disable-line react-hooks/exhaustive-deps
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

  const { startListening, stopListening, isListening, error: vadError } =
    useVAD({
      onSpeechStart: () => {
        // future: "I hear you" visual indicator
      },
      onSpeechEnd: (audio) => {
        const speechEndTime = Date.now();
        const blob = encodeWav(audio, 16000);
        triggerTranscription(blob, true, speechEndTime);
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
    if (recordingMode === "continuous") {
      if (isListening) {
        // Stop: if a segment is in-flight, flag for drain; otherwise go to done
        if (state === "processing") {
          stopRequestedRef.current = true;
        } else {
          setState("done");
        }
        stopListening();
      } else {
        setState("listening");
        setError("");
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
      }
    }
  }, [
    recordingMode,
    isListening,
    isRecording,
    state,
    startListening,
    stopListening,
    startRecording,
    stopRecording,
  ]);

  const handleToggleRecording = useCallback(() => {
    if (settingsOpen) return;
    // Push-to-talk: block during processing (can't start new recording)
    // Continuous + isListening: allow during processing (drain-then-done stop)
    if (state === "processing" && !isListening) return;
    handleToggle();
  }, [settingsOpen, state, isListening, handleToggle]);

  const handleCopyTranscript = useCallback(() => {
    if (transcript) {
      navigator.clipboard.writeText(transcript).catch(() => {});
    }
  }, [transcript]);

  const handleClearTranscript = useCallback(() => {
    setTranscript("");
    setRawTranscript("");
    setState("idle");
  }, []);

  const handleToggleSettings = useCallback(() => {
    if (state === "recording" || state === "listening" || state === "processing")
      return;
    setSettingsOpen((prev) => !prev);
  }, [state]);

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

  // In continuous mode, the user can click Stop while processing (drain-then-done).
  // isListening=true means the VAD is running — Stop is a valid action.
  // Push-to-talk processing blocks all recording actions.
  const isDisabled =
    (state === "processing" && !isListening) || modelSwapping || !backendReady;
  const isActiveSession =
    state === "recording" || state === "listening" || state === "processing";

  return (
    <div className="app">
      <div className="app-header">
        <h1>Voice Scribe</h1>
        <button
          className="settings-btn"
          onClick={handleToggleSettings}
          disabled={isActiveSession}
          aria-label="Settings"
        >
          &#9881;
        </button>
      </div>
      <Recorder
        state={state}
        isRecording={isRecording || isListening}
        onToggle={handleToggle}
        recorderError={recorderError}
        disabled={isDisabled}
        backendReady={backendReady}
      />
      {error && <p className="error">{error}</p>}
      <Transcript
        text={transcript}
        rawText={rawTranscript}
        isLoading={state === "processing"}
        onTextChange={setTranscript}
        showComparison={showRawComparison}
      />
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSwapStateChange={setModelSwapping}
        showRawComparison={showRawComparison}
        onShowRawComparisonChange={handleSetShowRawComparison}
        recordingMode={recordingMode}
        onRecordingModeChange={handleSetRecordingMode}
        isActive={isActiveSession}
      />
      <div className="hotkey-hints">
        Ctrl+Shift+Space: Record &nbsp;|&nbsp; Ctrl+Shift+Y: Copy &nbsp;|&nbsp;
        Ctrl+Shift+X: Clear &nbsp;|&nbsp; Ctrl+Shift+S: Settings
      </div>
    </div>
  );
}
