import { useEffect } from "react";

interface UseHotkeysOptions {
  onToggleRecording: () => void;
  onCopyTranscript: () => void;
  onClearTranscript: () => void;
  onToggleSettings: () => void;
}

const HOTKEYS: Record<string, keyof UseHotkeysOptions> = {
  " ": "onToggleRecording",   // Ctrl+Shift+Space
  "Y": "onCopyTranscript",    // Ctrl+Shift+Y
  "X": "onClearTranscript",   // Ctrl+Shift+X
  "S": "onToggleSettings",    // Ctrl+Shift+S
};

export function useHotkeys(options: UseHotkeysOptions): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
        return;
      }

      const key = event.key;
      const handler = HOTKEYS[key];

      if (handler) {
        event.preventDefault();
        options[handler]();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [options]);
}
