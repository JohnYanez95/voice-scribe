import { useEffect } from "react";
import { useRecorder } from "../../hooks/useRecorder";
import type { RecordingState } from "../../types";

interface RecorderProps {
  state: RecordingState;
  onStateChange: (state: RecordingState) => void;
  onRecordingComplete: (blob: Blob) => void;
}

export function Recorder({ state, onStateChange, onRecordingComplete }: RecorderProps) {
  const { startRecording, stopRecording, audioBlob, isRecording, error } = useRecorder();

  // Sync hook state with parent
  useEffect(() => {
    if (error) {
      onStateChange("error");
    }
  }, [error, onStateChange]);

  useEffect(() => {
    if (audioBlob) {
      onRecordingComplete(audioBlob);
    }
  }, [audioBlob, onRecordingComplete]);

  const handleClick = async () => {
    if (isRecording) {
      stopRecording();
    } else {
      onStateChange("recording");
      await startRecording();
    }
  };

  const isDisabled = state === "processing";

  return (
    <div className="recorder">
      <button
        className={`record-btn ${isRecording ? "recording" : ""}`}
        onClick={handleClick}
        disabled={isDisabled}
      >
        {isRecording ? "Stop" : state === "processing" ? "Processing..." : "Record"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
