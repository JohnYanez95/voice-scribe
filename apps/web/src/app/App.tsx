import { useCallback, useState } from "react";
import { Recorder } from "../features/recorder/Recorder";
import { Transcript } from "../features/transcript/Transcript";
import { transcribeAudio } from "../services/api";
import type { RecordingState } from "../types";

export function App() {
  const [state, setState] = useState<RecordingState>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");

  const handleRecordingComplete = useCallback(async (blob: Blob) => {
    setState("processing");
    setError("");

    try {
      const result = await transcribeAudio(blob);
      setTranscript(result.cleaned);
      setState("done");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      setError(message);
      setState("error");
    }
  }, []);

  const handleStateChange = useCallback((newState: RecordingState) => {
    setState(newState);
    if (newState === "recording") {
      setError("");
    }
  }, []);

  return (
    <div className="app">
      <h1>Voice Scribe</h1>
      <Recorder
        state={state}
        onStateChange={handleStateChange}
        onRecordingComplete={handleRecordingComplete}
      />
      {error && <p className="error">{error}</p>}
      <Transcript
        text={transcript}
        isLoading={state === "processing"}
        onTextChange={setTranscript}
      />
    </div>
  );
}
