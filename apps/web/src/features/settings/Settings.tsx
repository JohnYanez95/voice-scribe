import { useCallback, useEffect, useState } from "react";
import { listModels, swapModel } from "../../services/api";
import type { ModelInfo } from "../../types";

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onSwapStateChange: (swapping: boolean) => void;
  showRawComparison: boolean;
  onShowRawComparisonChange: (show: boolean) => void;
}

type PanelState = "loading" | "ready" | "swapping" | "error";

export function Settings({ isOpen, onClose, onSwapStateChange, showRawComparison, onShowRawComparisonChange }: SettingsProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  const [panelState, setPanelState] = useState<PanelState>("loading");
  const [statusMessage, setStatusMessage] = useState("");

  const fetchModels = useCallback(async () => {
    setPanelState("loading");
    setStatusMessage("");
    try {
      const data = await listModels();
      setModels(data.models);
      setCurrentModel(data.current_model);
      setPanelState("ready");
    } catch {
      setPanelState("error");
      setStatusMessage("Failed to load models");
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchModels();
    }
  }, [isOpen, fetchModels]);

  useEffect(() => {
    if (!isOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  const handleSwap = useCallback(
    async (modelName: string) => {
      if (modelName === currentModel) return;

      setPanelState("swapping");
      setStatusMessage("");
      onSwapStateChange(true);

      try {
        const result = await swapModel(modelName);
        setCurrentModel(result.current_model);
        setModels((prev) =>
          prev.map((m) => ({ ...m, is_current: m.name === result.current_model }))
        );
        setStatusMessage(`Swapped in ${result.swap_duration.toFixed(1)}s`);
        setPanelState("ready");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Model swap failed";
        setStatusMessage(message);
        setPanelState("ready");
      } finally {
        onSwapStateChange(false);
      }
    },
    [currentModel, onSwapStateChange]
  );

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
          <h3>Model</h3>

          {panelState === "loading" && (
            <p className="settings-status">Loading models...</p>
          )}

          {panelState === "error" && (
            <div className="settings-error">
              <p>{statusMessage}</p>
              <button className="settings-retry" onClick={fetchModels}>
                Retry
              </button>
            </div>
          )}

          {(panelState === "ready" || panelState === "swapping") && (
            <div className="settings-model-list">
              {models.map((m) => (
                <label key={m.name} className="settings-model-option">
                  <input
                    type="radio"
                    name="model"
                    value={m.name}
                    checked={m.name === currentModel}
                    onChange={() => handleSwap(m.name)}
                    disabled={panelState === "swapping"}
                  />
                  <span>{m.name}</span>
                </label>
              ))}
            </div>
          )}

          {panelState === "swapping" && (
            <p className="settings-status">Swapping model...</p>
          )}

          {statusMessage && panelState === "ready" && (
            <p className="settings-status">{statusMessage}</p>
          )}

          <p className="settings-note">
            First use of a model may require download.
          </p>
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
      </div>
    </>
  );
}
