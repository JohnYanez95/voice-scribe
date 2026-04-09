import type { RecordingState } from "../../types";

interface RecorderProps {
  state: RecordingState;
  isRecording: boolean;
  onToggle: () => void;
  recorderError: string | null;
  disabled: boolean;
  backendReady: boolean;
}

export function Recorder({
  state,
  isRecording,
  onToggle,
  recorderError,
  disabled,
  backendReady,
}: RecorderProps) {
  const buttonText = !backendReady
    ? "Starting backend..."
    : isRecording
      ? "Stop"
      : state === "processing"
        ? "Processing..."
        : "Record";

  return (
    <div className="recorder">
      <button
        className={`record-btn ${isRecording ? "recording" : ""}`}
        onClick={onToggle}
        disabled={disabled}
      >
        <span className="record-indicator" />
        {buttonText}
      </button>
      {recorderError && <p className="error">{recorderError}</p>}
    </div>
  );
}
