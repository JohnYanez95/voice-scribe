import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Recorder } from "../features/recorder/Recorder";
import { Settings } from "../features/settings/Settings";
import { Transcript } from "../features/transcript/Transcript";
import { useRecorder } from "../hooks/useRecorder";
import { useHotkeys } from "../hooks/useHotkeys";
import { streamTranscribeAudio, transcribeAudio } from "../services/api";
import type { RecordingState } from "../types";

export function App() {
  const [state, setState] = useState<RecordingState>("idle");
  const [transcript, setTranscript] = useState("");
  const [rawTranscript, setRawTranscript] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSwapping, setModelSwapping] = useState(false);
  const [showRawComparison, setShowRawComparison] = useState<boolean>(
    () => localStorage.getItem("voice-scribe-show-comparison") === "true"
  );

  const wsCleanupRef = useRef<(() => void) | null>(null);

  const handleSetShowRawComparison = useCallback((show: boolean) => {
    localStorage.setItem("voice-scribe-show-comparison", String(show));
    setShowRawComparison(show);
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

  // Cleanup WebSocket on unmount
  useEffect(() => () => { wsCleanupRef.current?.(); }, []);

  // Handle completed recording — stream via WebSocket, fall back to HTTP POST on connection failure only
  useEffect(() => {
    if (!audioBlob) return;

    // Cancel any in-flight connection from a previous recording
    wsCleanupRef.current?.();

    setState("processing");
    setError("");
    setTranscript("");
    setRawTranscript("");

    wsCleanupRef.current = streamTranscribeAudio(
      audioBlob,
      (text) => setTranscript((prev) => (prev ? prev + " " + text : text)),
      (result) => {
        setRawTranscript(result.raw);
        setTranscript(result.cleaned);
        setState("done");
      },
      () => {
        // Connection-level failure — WebSocket never established or dropped before
        // any server response. Server may still be serving HTTP; fall back.
        transcribeAudio(audioBlob)
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
      },
      (detail) => {
        // Application-level failure — connection was fine, server hit an error
        // (inference, transcode). Same error will occur on HTTP POST. Surface immediately.
        setError(detail);
        setState("error");
      }
    );
  }, [audioBlob]);

  const handleToggle = useCallback(async () => {
    if (isRecording) {
      stopRecording();
    } else {
      setState("recording");
      setError("");
      await startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  const handleToggleRecording = useCallback(() => {
    if (settingsOpen) return;
    if (state === "processing") return;
    handleToggle();
  }, [settingsOpen, state, handleToggle]);

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
    if (state === "recording" || state === "processing") return;
    setSettingsOpen((prev) => !prev);
  }, [state]);

  const hotkeyHandlers = useMemo(
    () => ({
      onToggleRecording: handleToggleRecording,
      onCopyTranscript: handleCopyTranscript,
      onClearTranscript: handleClearTranscript,
      onToggleSettings: handleToggleSettings,
    }),
    [handleToggleRecording, handleCopyTranscript, handleClearTranscript, handleToggleSettings]
  );

  useHotkeys(hotkeyHandlers);

  const isDisabled = state === "processing" || modelSwapping;

  return (
    <div className="app">
      <div className="app-header">
        <h1>Voice Scribe</h1>
        <button
          className="settings-btn"
          onClick={handleToggleSettings}
          disabled={state === "recording" || state === "processing"}
          aria-label="Settings"
        >
          &#9881;
        </button>
      </div>
      <Recorder
        state={state}
        isRecording={isRecording}
        onToggle={handleToggle}
        recorderError={recorderError}
        disabled={isDisabled}
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
      />
      <div className="hotkey-hints">
        Ctrl+Shift+Space: Record &nbsp;|&nbsp; Ctrl+Shift+Y: Copy &nbsp;|&nbsp;
        Ctrl+Shift+X: Clear &nbsp;|&nbsp; Ctrl+Shift+S: Settings
      </div>
    </div>
  );
}
