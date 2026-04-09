import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { App } from "../src/app/App";

// ---------------------------------------------------------------------------
// Mocks — same minimal set as other App-level tests
// ---------------------------------------------------------------------------

vi.mock("../src/hooks/useVAD", () => ({
  useVAD: vi.fn(() => ({
    startListening: vi.fn(),
    stopListening: vi.fn(),
    isListening: false,
    error: null,
  })),
}));

vi.mock("../src/services/api", () => ({
  streamTranscribeAudio: vi.fn(),
  transcribeAudio: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [], current_model: "" }),
  swapModel: vi.fn(),
}));

vi.mock("../src/hooks/useRecorder", () => ({
  useRecorder: () => ({
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    audioBlob: null,
    isRecording: false,
    error: null,
  }),
}));

vi.mock("../src/services/audio", () => ({
  playCopySound: vi.fn().mockResolvedValue(undefined),
  playClearSound: vi.fn().mockResolvedValue(undefined),
  initAudio: vi.fn().mockResolvedValue(undefined),
  setAudioMuted: vi.fn(),
  isAudioMuted: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Theme toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "dark");
  });

  it("click toggles data-theme from dark to light and persists to localStorage", () => {
    render(<App />);

    const btn = screen.getByLabelText("Toggle theme");
    fireEvent.click(btn);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("voice-scribe-theme")).toBe("light");
  });

  it("second click returns to dark", () => {
    render(<App />);

    const btn = screen.getByLabelText("Toggle theme");
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("voice-scribe-theme")).toBe("dark");
  });
});
