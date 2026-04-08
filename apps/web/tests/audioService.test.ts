/**
 * Audio cue service tests — playback, preload, and mute behavior.
 *
 * Mocks HTMLAudioElement to verify:
 *   - initAudio creates both Audio elements
 *   - playCopySound / playClearSound call play()
 *   - Muted state skips playback entirely
 *   - Rapid plays reset currentTime
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// HTMLAudioElement mock
// ---------------------------------------------------------------------------

const mockPlay = vi.fn().mockResolvedValue(undefined);

// Track all Audio instances created
const audioInstances: Array<{ src: string; preload: string; currentTime: number; play: typeof mockPlay }> = [];

vi.stubGlobal("Audio", vi.fn((src: string) => {
  const instance = {
    src,
    preload: "",
    currentTime: 0,
    play: mockPlay,
  };
  audioInstances.push(instance);
  return instance;
}));

// ---------------------------------------------------------------------------
// Reset module state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  audioInstances.length = 0;
  mockPlay.mockResolvedValue(undefined);
  vi.resetModules();
});

async function importAudio() {
  return import("../src/services/audio");
}

describe("initAudio", () => {
  it("creates Audio elements for both copy and clear", async () => {
    const { initAudio } = await importAudio();
    await initAudio();

    expect(audioInstances).toHaveLength(2);
    expect(audioInstances[0].src).toBe("/sounds/copy.wav");
    expect(audioInstances[1].src).toBe("/sounds/clear.wav");
  });

  it("sets preload to auto", async () => {
    const { initAudio } = await importAudio();
    await initAudio();

    expect(audioInstances[0].preload).toBe("auto");
    expect(audioInstances[1].preload).toBe("auto");
  });
});

describe("playCopySound", () => {
  it("calls play() on the copy Audio element", async () => {
    const { initAudio, playCopySound } = await importAudio();
    await initAudio();

    await playCopySound();

    expect(mockPlay).toHaveBeenCalledOnce();
  });

  it("resets currentTime before playing (supports rapid repeats)", async () => {
    const { initAudio, playCopySound } = await importAudio();
    await initAudio();
    // Simulate mid-playback state
    audioInstances[0].currentTime = 0.15;

    await playCopySound();

    expect(audioInstances[0].currentTime).toBe(0);
    expect(mockPlay).toHaveBeenCalledOnce();
  });

  it("is a no-op when not initialized", async () => {
    const { playCopySound } = await importAudio();
    // No initAudio — audio element is null

    await playCopySound();

    expect(mockPlay).not.toHaveBeenCalled();
  });

  it("does not play when muted", async () => {
    const { initAudio, playCopySound, setAudioMuted } = await importAudio();
    await initAudio();
    setAudioMuted(true);

    await playCopySound();

    expect(mockPlay).not.toHaveBeenCalled();
  });
});

describe("playClearSound", () => {
  it("calls play() on the clear Audio element", async () => {
    const { initAudio, playClearSound } = await importAudio();
    await initAudio();

    await playClearSound();

    expect(mockPlay).toHaveBeenCalledOnce();
  });

  it("does not play when muted", async () => {
    const { initAudio, playClearSound, setAudioMuted } = await importAudio();
    await initAudio();
    setAudioMuted(true);

    await playClearSound();

    expect(mockPlay).not.toHaveBeenCalled();
  });
});

describe("setAudioMuted / isAudioMuted", () => {
  it("defaults to not muted", async () => {
    const { isAudioMuted } = await importAudio();
    expect(isAudioMuted()).toBe(false);
  });

  it("setAudioMuted(true) enables mute", async () => {
    const { setAudioMuted, isAudioMuted } = await importAudio();
    setAudioMuted(true);
    expect(isAudioMuted()).toBe(true);
  });

  it("setAudioMuted(false) disables mute", async () => {
    const { setAudioMuted, isAudioMuted } = await importAudio();
    setAudioMuted(true);
    setAudioMuted(false);
    expect(isAudioMuted()).toBe(false);
  });
});
