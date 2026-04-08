/**
 * Audio cue playback for voice command feedback.
 *
 * Plays short sound effects when voice commands fire:
 *   - Copy: ascending chime after clipboard write succeeds
 *   - Clear: descending sweep when transcript is cleared
 *
 * Uses HTMLAudioElement instead of Web Audio API. Simpler, and critically:
 * routes through the OS audio system directly, so it survives audio device
 * changes (headphone disconnect/reconnect) without losing the output path.
 *
 * Audio elements are preloaded on App mount via initAudio(). If preload
 * fails, playback is a no-op — the cue is feedback, not functionality.
 * Mute state is module-scoped — set via setAudioMuted(), persisted in
 * localStorage by App.tsx.
 */

let copyAudio: HTMLAudioElement | null = null;
let clearAudio: HTMLAudioElement | null = null;
let muted = false;

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

async function play(audio: HTMLAudioElement | null): Promise<void> {
  if (!audio) return;
  // Reset to start so rapid repeated plays don't skip
  audio.currentTime = 0;
  await audio.play();
}

export async function playCopySound(): Promise<void> {
  if (muted) return;
  await play(copyAudio);
}

export async function playClearSound(): Promise<void> {
  if (muted) return;
  await play(clearAudio);
}

export function setAudioMuted(value: boolean): void {
  muted = value;
}

export function isAudioMuted(): boolean {
  return muted;
}
