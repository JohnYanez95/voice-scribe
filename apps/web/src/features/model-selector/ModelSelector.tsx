import { useCallback, useEffect, useState } from "react";
import { listModels, swapModel } from "../../services/api";
import type { ModelInfo } from "../../types";

interface ModelSelectorProps {
  backendReady: boolean;
  onSwapStateChange: (swapping: boolean) => void;
}

type SelectorState = "idle" | "loading" | "ready" | "swapping" | "error";

export function ModelSelector({
  backendReady,
  onSwapStateChange,
}: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  const [selectorState, setSelectorState] = useState<SelectorState>("idle");
  const [statusMessage, setStatusMessage] = useState("");

  const fetchModels = useCallback(async () => {
    setSelectorState("loading");
    setStatusMessage("");
    try {
      const data = await listModels();
      setModels(data.models);
      setCurrentModel(data.current_model);
      setSelectorState("ready");
    } catch {
      setSelectorState("error");
      setStatusMessage("Failed to load models");
    }
  }, []);

  // Gate fetch on backend readiness — in Tauri mode the sidecar
  // hasn't started when this component mounts.
  useEffect(() => {
    if (backendReady) {
      fetchModels();
    }
  }, [backendReady, fetchModels]);

  const handleChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const modelName = e.target.value;
      if (modelName === currentModel) return;

      setSelectorState("swapping");
      setStatusMessage("Swapping...");
      onSwapStateChange(true);

      try {
        const result = await swapModel(modelName);
        setCurrentModel(result.current_model);
        setModels((prev) =>
          prev.map((m) => ({
            ...m,
            is_current: m.name === result.current_model,
          }))
        );
        setStatusMessage(`Swapped in ${result.swap_duration.toFixed(1)}s`);
        setSelectorState("ready");
        // Clear status after a few seconds
        setTimeout(() => setStatusMessage(""), 3000);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Model swap failed";
        setStatusMessage(message);
        setSelectorState("ready");
      } finally {
        onSwapStateChange(false);
      }
    },
    [currentModel, onSwapStateChange]
  );

  // Before backend is ready or during initial load — show disabled placeholder
  if (!backendReady || selectorState === "idle" || selectorState === "loading") {
    return (
      <div className="model-selector">
        <select disabled>
          <option>{selectorState === "loading" ? "Loading..." : "Model"}</option>
        </select>
      </div>
    );
  }

  if (selectorState === "error") {
    return (
      <div className="model-selector">
        <select disabled>
          <option>Error</option>
        </select>
      </div>
    );
  }

  return (
    <div className="model-selector">
      <select
        value={currentModel}
        onChange={handleChange}
        disabled={selectorState === "swapping"}
      >
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>
      {statusMessage && (
        <span className="model-selector-status">{statusMessage}</span>
      )}
    </div>
  );
}
