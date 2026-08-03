/**
 * Streaming wire diagnostic — developer mode (2026-08-02).
 *
 * OFF by default. Enabled ONLY by the URL param `?debug=stream`, read once at
 * module init and never persisted: unlike Settings/localStorage preferences,
 * a diagnostic that captures transcript text must NOT survive a reload by
 * accident — a plain reload turns it off.
 *
 * Privacy posture (this is the one path where transcript text can leave the
 * page, so the rules are explicit):
 * - Memory-only ring buffer, hard-capped; never written to localStorage,
 *   IndexedDB, or disk, never transmitted anywhere.
 * - Export is a user-initiated Blob download only (browser + desktop webview
 *   alike — it must never touch the Rust HTTP server on 8001).
 * - The export CONTAINS TRANSCRIPT TEXT — stated at the export surface.
 * - No audio, ever: PCM frames are recorded as count/byte aggregates only.
 * - Cleared on every new session open and on page unload.
 * - Backend logging rules are untouched (no server changes).
 */

const enabled =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("debug") === "stream";

const MAX_RECORDS = 2000;

export interface WireRecord {
  /** performance.now() ms — pair with wall_clock_anchor in the export. */
  t_ms: number;
  dir: "in" | "out" | "client";
  [key: string]: unknown;
}

const records: WireRecord[] = [];
let frameCount = 0;
let frameBytes = 0;
let wallAnchor: string | null = null;

export function wireDebugEnabled(): boolean {
  return enabled;
}

/** Capture one wire message (in/out) or client-side marker. Drop-oldest past cap. */
export function recordWire(dir: WireRecord["dir"], payload: Record<string, unknown>): void {
  if (!enabled) return;
  if (wallAnchor === null) wallAnchor = new Date().toISOString();
  records.push({ t_ms: Math.round(performance.now()), dir, ...payload });
  if (records.length > MAX_RECORDS) records.shift();
}

/** Client-side capture markers (speech_start / speech_end / misfire): without
 * these a server finalization delay is indistinguishable from VAD lag. */
export function recordWireMarker(marker: string): void {
  recordWire("client", { type: marker });
}

/** Audio frames: aggregate only — never sample data. */
export function recordWireFrameSent(bytes: number): void {
  if (!enabled) return;
  frameCount += 1;
  frameBytes += bytes;
}

export function clearWireLog(): void {
  records.length = 0;
  frameCount = 0;
  frameBytes = 0;
  wallAnchor = null;
}

/** User-initiated download. The only way data leaves memory. */
export function exportWireLog(): void {
  if (!enabled || typeof document === "undefined") return;
  const body = JSON.stringify(
    {
      note: "Contains transcript text. User-initiated export; nothing was persisted or transmitted.",
      wall_clock_anchor: wallAnchor,
      frames_sent: { count: frameCount, bytes: frameBytes },
      records,
    },
    null,
    1
  );
  const blob = new Blob([body], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `voice-scribe-wire-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

if (enabled && typeof window !== "undefined") {
  window.addEventListener("beforeunload", clearWireLog);
}
