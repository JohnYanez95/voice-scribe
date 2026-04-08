#!/usr/bin/env python3
"""Generate audio cue WAV files for voice command feedback.

Copy cue:  ascending two-tone chime with smooth crossfade and decay, 0.35s
Clear cue: descending frequency sweep with exponential decay, 0.35s

Output: apps/web/public/sounds/{copy,clear}.wav
Requires: numpy (stdlib wave module handles WAV encoding)
"""

import os
import wave

import numpy as np

SAMPLE_RATE = 44100
AMPLITUDE = 0.35  # moderate volume — notification, not alarm
# Silence padding absorbs Bluetooth A2DP codec ramp-up latency.
# The codec buffer needs to fill before audio reaches the DAC — without
# padding, the first ~50-80ms of the actual sound is eaten.
PAD_MS = 80  # ms of silence before and after the sound


def exp_decay(n_samples: int, decay_rate: float = 5.0) -> np.ndarray:
    """Exponential decay envelope — natural instrument-like falloff."""
    t = np.linspace(0, 1, n_samples)
    return np.exp(-decay_rate * t)


def smooth_fade(n_samples: int, fade_in_ms: int = 30, fade_out_ms: int = 40) -> np.ndarray:
    """Smooth fade-in/fade-out to eliminate click artifacts."""
    env = np.ones(n_samples)
    fade_in = int(SAMPLE_RATE * fade_in_ms / 1000)
    fade_out = int(SAMPLE_RATE * fade_out_ms / 1000)
    if fade_in > 0:
        # Raised cosine fade-in (smoother than linear)
        env[:fade_in] = 0.5 * (1 - np.cos(np.pi * np.arange(fade_in) / fade_in))
    if fade_out > 0:
        env[-fade_out:] = 0.5 * (1 + np.cos(np.pi * np.arange(fade_out) / fade_out))
    return env


def generate_copy_chime() -> np.ndarray:
    """Ascending two-tone chime: E5 → A5 with smooth crossfade and harmonics."""
    duration = 0.35
    n_samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, n_samples, endpoint=False)

    freq1 = 659.25   # E5
    freq2 = 880.00   # A5

    # Smooth crossfade between tones (cosine blend, no hard cut)
    blend = 0.5 * (1 - np.cos(np.pi * t / duration))  # 0→1 over full duration

    tone1 = np.sin(2 * np.pi * freq1 * t)
    tone2 = np.sin(2 * np.pi * freq2 * t)

    # Add quiet second harmonic for warmth (half amplitude)
    tone1 += 0.3 * np.sin(2 * np.pi * freq1 * 2 * t)
    tone2 += 0.3 * np.sin(2 * np.pi * freq2 * 2 * t)

    signal = tone1 * (1 - blend) + tone2 * blend
    signal *= exp_decay(n_samples, decay_rate=4.0)
    signal *= smooth_fade(n_samples)
    # Normalize then scale
    peak = np.max(np.abs(signal))
    if peak > 0:
        signal = signal / peak * AMPLITUDE
    return signal


def generate_clear_sweep() -> np.ndarray:
    """Descending frequency sweep: A5 → E4 with exponential decay."""
    duration = 0.30
    n_samples = int(SAMPLE_RATE * duration)
    t = np.linspace(0, duration, n_samples, endpoint=False)

    # Exponential frequency sweep (more natural than linear)
    freq_start = 880.00   # A5
    freq_end = 329.63     # E4
    freq = freq_start * (freq_end / freq_start) ** (t / duration)
    phase = 2 * np.pi * np.cumsum(freq) / SAMPLE_RATE

    signal = np.sin(phase)
    # Light second harmonic
    signal += 0.2 * np.sin(2 * phase)

    signal *= exp_decay(n_samples, decay_rate=5.0)
    signal *= smooth_fade(n_samples, fade_in_ms=15, fade_out_ms=50)
    peak = np.max(np.abs(signal))
    if peak > 0:
        signal = signal / peak * AMPLITUDE
    return signal


def pad_silence(signal: np.ndarray, pad_ms: int = PAD_MS) -> np.ndarray:
    """Add silence before and after the signal for Bluetooth codec ramp-up."""
    pad_samples = int(SAMPLE_RATE * pad_ms / 1000)
    return np.concatenate([
        np.zeros(pad_samples),
        signal,
        np.zeros(pad_samples),
    ])


def write_wav(path: str, signal: np.ndarray) -> None:
    """Write mono 16-bit WAV file with silence padding."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    padded = pad_silence(signal)
    pcm = (padded * 32767).astype(np.int16)

    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())


def main() -> None:
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sounds_dir = os.path.join(repo_root, "apps", "web", "public", "sounds")

    copy_path = os.path.join(sounds_dir, "copy.wav")
    clear_path = os.path.join(sounds_dir, "clear.wav")

    write_wav(copy_path, generate_copy_chime())
    print(f"Generated {copy_path}")

    write_wav(clear_path, generate_clear_sweep())
    print(f"Generated {clear_path}")


if __name__ == "__main__":
    main()
