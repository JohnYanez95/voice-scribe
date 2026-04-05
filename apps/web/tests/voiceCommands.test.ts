import { describe, it, expect } from "vitest";
import { detectVoiceCommand } from "../src/utils/voiceCommands";

describe("detectVoiceCommand", () => {
  // Canonical forms
  it("matches 'copy'", () => {
    expect(detectVoiceCommand("copy")).toBe("copy");
  });

  it("matches 'clear'", () => {
    expect(detectVoiceCommand("clear")).toBe("clear");
  });

  // Whisper's capitalized first letter
  it("matches 'Copy'", () => {
    expect(detectVoiceCommand("Copy")).toBe("copy");
  });

  it("matches 'Clear'", () => {
    expect(detectVoiceCommand("Clear")).toBe("clear");
  });

  // All caps
  it("matches 'COPY'", () => {
    expect(detectVoiceCommand("COPY")).toBe("copy");
  });

  it("matches 'CLEAR'", () => {
    expect(detectVoiceCommand("CLEAR")).toBe("clear");
  });

  // Trailing punctuation variants
  it("strips trailing period: 'Copy.'", () => {
    expect(detectVoiceCommand("Copy.")).toBe("copy");
  });

  it("strips trailing period: 'Clear.'", () => {
    expect(detectVoiceCommand("Clear.")).toBe("clear");
  });

  it("strips trailing exclamation: 'copy!'", () => {
    expect(detectVoiceCommand("copy!")).toBe("copy");
  });

  it("strips trailing comma: 'clear,'", () => {
    expect(detectVoiceCommand("clear,")).toBe("clear");
  });

  // Exact-segment: embedded occurrences must NOT fire
  it("does not match mid-sentence: 'copy that function and paste it below'", () => {
    expect(detectVoiceCommand("copy that function and paste it below")).toBeNull();
  });

  it("does not match mid-sentence: 'let me clear this up before we move on'", () => {
    expect(detectVoiceCommand("let me clear this up before we move on")).toBeNull();
  });

  it("does not match mid-sentence: 'make a copy of the config'", () => {
    expect(detectVoiceCommand("make a copy of the config")).toBeNull();
  });

  it("does not match mid-sentence: 'clear the cache and restart'", () => {
    expect(detectVoiceCommand("clear the cache and restart")).toBeNull();
  });

  // Leading words
  it("does not match leading words: 'please copy'", () => {
    expect(detectVoiceCommand("please copy")).toBeNull();
  });

  it("does not match leading words: 'please clear'", () => {
    expect(detectVoiceCommand("please clear")).toBeNull();
  });

  // Trailing words
  it("does not match trailing words: 'copy now'", () => {
    expect(detectVoiceCommand("copy now")).toBeNull();
  });

  it("does not match trailing words: 'clear now'", () => {
    expect(detectVoiceCommand("clear now")).toBeNull();
  });

  // Edge cases
  it("returns null for empty string", () => {
    expect(detectVoiceCommand("")).toBeNull();
  });

  it("returns null for unrelated text", () => {
    expect(detectVoiceCommand("Hello world")).toBeNull();
  });

  it("returns null for old 'scribe stop' phrase", () => {
    expect(detectVoiceCommand("scribe stop")).toBeNull();
  });

  it("returns null for old 'scribe clear' phrase", () => {
    expect(detectVoiceCommand("scribe clear")).toBeNull();
  });
});
