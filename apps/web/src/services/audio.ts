/**
 * Audio cue playback for voice command feedback.
 *
 * Plays short sound effects when voice commands fire:
 *   - Copy: ascending chime after clipboard write succeeds
 *   - Clear: descending sweep when transcript is cleared
 *
 * Two playback paths:
 *   - Browser: HTMLAudioElement (routes through OS audio, survives device
 *     changes better than AudioContext)
 *   - Desktop (Tauri): POST to Rust audio server on port 8001. The Rust
 *     process plays WAV files via rodio, bypassing WebKitGTK's audio
 *     subsystem entirely. Same pattern as the clipboard server.
 *
 * Audio elements are preloaded on App mount via initAudio(). If preload
 * fails, playback is a no-op — the cue is feedback, not functionality.
 * Mute state is module-scoped — set via setAudioMuted(), persisted in
 * localStorage by App.tsx.
 */

import { isDesktop } from "./platform";

let copyAudio: HTMLAudioElement | null = null;
let clearAudio: HTMLAudioElement | null = null;
let muted = false;

const AUDIO_URL = "http://127.0.0.1:8001/audio/play";

function createAudio(url: string): HTMLAudioElement {
  const audio = new Audio(url);
  audio.preload = "auto";
  return audio;
}

/** Preload both audio elements. Call once on App mount. */
export async function initAudio(): Promise<void> {
  try {
    copyAudio = createAudio("/sounds/copy.wav");
    clearAudio = createAudio("/sounds/clear.wav");
  } catch {
    // Preload failed — playback functions will be no-ops
  }
}

/** Browser path: play via HTMLAudioElement. */
async function playLocal(audio: HTMLAudioElement | null): Promise<void> {
  if (!audio) return;
  // Reset to start so rapid repeated plays don't skip
  audio.currentTime = 0;
  await audio.play();
}

/** Desktop path: POST sound name to Rust audio server (rodio). */
async function playViaServer(name: string): Promise<void> {
  const resp = await fetch(AUDIO_URL, {
    method: "POST",
    body: name,
  });
  if (!resp.ok) {
    throw new Error(`Audio playback failed (${resp.status})`);
  }
}

export async function playCopySound(): Promise<void> {
  if (muted) return;
  if (isDesktop()) {
    await playViaServer("copy");
  } else {
    await playLocal(copyAudio);
  }
}

export async function playClearSound(): Promise<void> {
  if (muted) return;
  if (isDesktop()) {
    await playViaServer("clear");
  } else {
    await playLocal(clearAudio);
  }
}

export function setAudioMuted(value: boolean): void {
  muted = value;
}

export function isAudioMuted(): boolean {
  return muted;
}
