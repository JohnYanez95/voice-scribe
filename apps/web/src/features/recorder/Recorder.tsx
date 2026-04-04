import type { RecordingState } from "../../types";

interface RecorderProps {
  state: RecordingState;
  isRecording: boolean;
  onToggle: () => void;
  recorderError: string | null;
  disabled: boolean;
}

export function Recorder({
  state,
  isRecording,
  onToggle,
  recorderError,
  disabled,
}: RecorderProps) {
  const buttonText = isRecording
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
        {buttonText}
      </button>
      {recorderError && <p className="error">{recorderError}</p>}
    </div>
  );
}
