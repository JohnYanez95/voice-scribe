/**
 * Platform abstraction layer — runtime detection and capability routing.
 *
 * Three exports:
 *   isDesktop()      — true when running inside the Tauri webview
 *   writeClipboard() — HTTP POST to Rust clipboard server in desktop,
 *                       navigator.clipboard in browser
 *   submitText()     — stub: calls writeClipboard() in both environments (submit deferred)
 *
 * Desktop clipboard writes POST to 127.0.0.1:8001/clipboard (plain text body).
 * The Rust process (main.rs) runs a tiny_http listener that writes to the
 * system clipboard via arboard. This bypasses WebKitGTK entirely — the browser's
 * Fetch API has no user-activation requirement for POST requests, so voice
 * commands (which fire from WebSocket callbacks with no user gesture) work.
 *
 * The Tauri clipboard plugin was tested and confirmed to crash WebKitGTK
 * when called without user activation (NeedDebuggerBreak trap). The HTTP
 * server is the permanent architecture for desktop clipboard writes.
 */

// Function, not a module-scope const. Called in useState initializers where the
// parentheses matter: useState(!isDesktop()) evaluates once per mount.
//
// Requires withGlobalTauri:true in tauri.conf.json so the Tauri runtime
// injects window.__TAURI__ into the webview.
export function isDesktop(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (window as any).__TAURI__ !== "undefined";
}

const CLIPBOARD_URL = "http://127.0.0.1:8001/clipboard";

export async function writeClipboard(text: string): Promise<void> {
  if (isDesktop()) {
    const resp = await fetch(CLIPBOARD_URL, {
      method: "POST",
      body: text,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "unknown error");
      throw new Error(`Clipboard write failed (${resp.status}): ${detail}`);
    }
  } else {
    await navigator.clipboard.writeText(text);
  }
}

// Stub — both environments route through writeClipboard. Direct text
// injection deferred indefinitely from Voice Scribe (see roadmap).
export async function submitText(text: string): Promise<void> {
  await writeClipboard(text);
}

/**
 * Emit recording state to the Rust process so the tray tooltip stays
 * in sync. No-op in browser mode. The Rust side listens for
 * "recording-state-changed" and updates the tray tooltip accordingly.
 */
export function emitRecordingState(state: string): void {
  if (!isDesktop()) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI__?.event?.emit("recording-state-changed", state);
}
