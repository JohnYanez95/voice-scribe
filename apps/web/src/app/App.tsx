import { useCallback, useEffect, useMemo, useState } from "react";
import { Recorder } from "../features/recorder/Recorder";
import { Settings } from "../features/settings/Settings";
import { Transcript } from "../features/transcript/Transcript";
import { useRecorder } from "../hooks/useRecorder";
import { useHotkeys } from "../hooks/useHotkeys";
import { transcribeAudio } from "../services/api";
import type { RecordingState } from "../types";

export function App() {
  const [state, setState] = useState<RecordingState>("idle");
  const [transcript, setTranscript] = useState("");
  const [rawTranscript, setRawTranscript] = useState("");
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSwapping, setModelSwapping] = useState(false);

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

  // Handle completed recording — send to API
  useEffect(() => {
    if (!audioBlob) return;

    setState("processing");
    setError("");

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
      />
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSwapStateChange={setModelSwapping}
      />
      <div className="hotkey-hints">
        Ctrl+Shift+Space: Record &nbsp;|&nbsp; Ctrl+Shift+Y: Copy &nbsp;|&nbsp;
        Ctrl+Shift+X: Clear &nbsp;|&nbsp; Ctrl+Shift+S: Settings
      </div>
    </div>
  );
}
