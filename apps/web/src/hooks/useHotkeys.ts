import { useEffect } from "react";

interface UseHotkeysOptions {
  onToggleRecording: () => void;
  onCopyTranscript: () => void;
  onClearTranscript: () => void;
  onToggleSettings: () => void;
}

// WebKitGTK intercepts certain Ctrl+Shift+* combinations at the native
// level before they reach the JavaScript keydown handler. In the Tauri
// desktop webview:
//
//   Ctrl+Shift+S     — WebKitGTK "Save As" shortcut. Never reaches JS.
//   Ctrl+Shift+Space — WebKitGTK accessibility activation. Alternating
//                       dispatch: first press swallowed, second press
//                       (modifiers held) delivered, third swallowed, etc.
//
// Y and X are unaffected — no WebKitGTK built-in binding claims them.
// In browser mode (Chromium, Firefox), all four bindings work reliably.
//
// The desktop hotkey hint string in App.tsx reflects this: only Y and X
// are advertised. Recording uses the UI button or tray menu. Settings
// uses the gear icon.
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
