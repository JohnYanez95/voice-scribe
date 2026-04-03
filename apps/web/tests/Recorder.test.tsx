import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Recorder } from "../src/features/recorder/Recorder";

describe("Recorder", () => {
  it("renders Record button in idle state", () => {
    render(
      <Recorder
        state="idle"
        onStateChange={() => {}}
        onRecordingComplete={() => {}}
      />
    );
    expect(screen.getByText("Record")).toBeTruthy();
  });

  it("shows Processing... when in processing state", () => {
    render(
      <Recorder
        state="processing"
        onStateChange={() => {}}
        onRecordingComplete={() => {}}
      />
    );
    const btn = screen.getByText("Processing...");
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Record button after done state", () => {
    render(
      <Recorder
        state="done"
        onStateChange={() => {}}
        onRecordingComplete={() => {}}
      />
    );
    expect(screen.getByText("Record")).toBeTruthy();
  });
});
