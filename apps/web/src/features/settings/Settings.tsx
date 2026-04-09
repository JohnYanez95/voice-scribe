import { useEffect } from "react";
import type { RecordingMode } from "../../types";

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  showRawComparison: boolean;
  onShowRawComparisonChange: (show: boolean) => void;
  recordingMode: RecordingMode;
  onRecordingModeChange: (mode: RecordingMode) => void;
  audioMuted: boolean;
  onAudioMutedChange: (muted: boolean) => void;
  maxDuration: number;
  onMaxDurationChange: (seconds: number) => void;
  /** True while recording, listening, or processing — disables mode toggle. */
  isActive: boolean;
}

export function Settings({
  isOpen,
  onClose,
  showRawComparison,
  onShowRawComparisonChange,
  recordingMode,
  onRecordingModeChange,
  audioMuted,
  onAudioMutedChange,
  maxDuration,
  onMaxDurationChange,
  isActive,
}: SettingsProps) {
  useEffect(() => {
    if (!isOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <>
      <div className="settings-overlay" onClick={onClose} />
      <div className="settings-panel">
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="settings-section">
          <h3>Display</h3>
          <label className="settings-model-option">
            <input
              type="checkbox"
              checked={showRawComparison}
              onChange={(e) => onShowRawComparisonChange(e.target.checked)}
            />
            <span>Show raw / cleaned comparison</span>
          </label>
          <p className="settings-note">
            When enabled, shows the unprocessed transcript alongside the cleaned version.
          </p>
        </div>

        <div className="settings-section">
          <h3>Recording Mode</h3>
          <div className="settings-model-list">
            <label className="settings-model-option">
              <input
                type="radio"
                name="recordingMode"
                value="push-to-talk"
                checked={recordingMode === "push-to-talk"}
                onChange={() => onRecordingModeChange("push-to-talk")}
                disabled={isActive}
              />
              <span>Push-to-talk</span>
            </label>
            <label className="settings-model-option">
              <input
                type="radio"
                name="recordingMode"
                value="continuous"
                checked={recordingMode === "continuous"}
                onChange={() => onRecordingModeChange("continuous")}
                disabled={isActive}
              />
              <span>Continuous</span>
            </label>
          </div>
          <p className="settings-note">
            Push-to-talk: hold to record, release to transcribe. Continuous: mic stays
            open, VAD detects speech automatically.
          </p>
          {isActive && (
            <p className="settings-note settings-locked">
              Stop recording to change mode.
            </p>
          )}
        </div>

        <div className="settings-section">
          <h3>Audio</h3>
          <label className="settings-model-option">
            <input
              type="checkbox"
              checked={audioMuted}
              onChange={(e) => onAudioMutedChange(e.target.checked)}
            />
            <span>Mute audio cues</span>
          </label>
          <p className="settings-note">
            Silence copy and clear sound effects.
          </p>
        </div>

        <div className="settings-section">
          <h3>Recording</h3>
          <label className="settings-duration-label" htmlFor="max-duration">
            Max recording duration (seconds)
          </label>
          <div className="settings-duration-input">
            <input
              id="max-duration"
              type="number"
              min={5}
              max={60}
              step={5}
              value={maxDuration}
              onChange={(e) => onMaxDurationChange(Number(e.target.value))}
              disabled={isActive}
            />
          </div>
          <p className="settings-note">
            Default: 60 s. Capped to match the backend upload limit —
            raising requires a matching server change.
          </p>
          {isActive && (
            <p className="settings-note settings-locked">
              Stop recording to change duration.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
