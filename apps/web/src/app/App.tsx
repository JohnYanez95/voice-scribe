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
import { initAudio, playCopySound, playClearSound, setAudioMuted } from "../services/audio";
import { isDesktop, writeClipboard, emitRecordingState } from "../services/platform";
import type { RecordingMode, RecordingState } from "../types";

const PARAGRAPH_BREAK_MS = 3000;

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

  const handleSetAudioMuted = useCallback((muted: boolean) => {
    localStorage.setItem("voice-scribe-audio-muted", String(muted));
    setAudioMuted(muted);
    setAudioMutedState(muted);
  }, []);

  const handleSetMaxDuration = useCallback((seconds: number) => {
    const clamped = Math.max(5, Math.min(300, seconds));
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
    // Clear any existing duration timer
    if (durationTimerRef.current) {
      clearTimeout(durationTimerRef.current);
      durationTimerRef.current = null;
    }

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
    if (state === "recording" || state === "listening" || state === "processing")
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
    state === "recording" || state === "listening" || state === "processing";

  return (
    <div className="app">
      <div className="toolbar-top">
        <ModelSelector
          backendReady={backendReady}
          onSwapStateChange={setModelSwapping}
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
        />
      </div>
      <div className="toolbar-bottom">
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
