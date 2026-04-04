import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Recorder } from "../src/features/recorder/Recorder";

const defaultProps = {
  state: "idle" as const,
  isRecording: false,
  onToggle: () => {},
  recorderError: null,
  disabled: false,
};

describe("Recorder", () => {
  it("renders Record button in idle state", () => {
    render(<Recorder {...defaultProps} />);
    expect(screen.getByText("Record")).toBeTruthy();
  });

  it("shows Processing... when in processing state", () => {
    render(<Recorder {...defaultProps} state="processing" disabled={true} />);
    const btn = screen.getByText("Processing...");
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Record button after done state", () => {
    render(<Recorder {...defaultProps} state="done" />);
    expect(screen.getByText("Record")).toBeTruthy();
  });

  it("shows Stop button when recording", () => {
    render(<Recorder {...defaultProps} state="recording" isRecording={true} />);
    expect(screen.getByText("Stop")).toBeTruthy();
  });

  it("shows recorder error when present", () => {
    render(<Recorder {...defaultProps} recorderError="Mic denied" />);
    expect(screen.getByText("Mic denied")).toBeTruthy();
  });
});
