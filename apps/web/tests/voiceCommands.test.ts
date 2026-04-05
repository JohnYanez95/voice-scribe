import { describe, it, expect } from "vitest";
import { detectVoiceCommand } from "../src/utils/voiceCommands";

describe("detectVoiceCommand", () => {
  // Canonical forms
  it("matches 'scribe stop'", () => {
    expect(detectVoiceCommand("scribe stop")).toBe("stop");
  });

  it("matches 'scribe submit'", () => {
    expect(detectVoiceCommand("scribe submit")).toBe("submit");
  });

  it("matches 'scribe redo'", () => {
    expect(detectVoiceCommand("scribe redo")).toBe("redo");
  });

  it("matches 'scribe clear'", () => {
    expect(detectVoiceCommand("scribe clear")).toBe("clear");
  });

  // Whisper's capitalized first letter
  it("matches 'Scribe stop'", () => {
    expect(detectVoiceCommand("Scribe stop")).toBe("stop");
  });

  it("matches 'Scribe Submit' (capital mid-word)", () => {
    expect(detectVoiceCommand("Scribe Submit")).toBe("submit");
  });

  it("matches 'SCRIBE STOP' (all caps)", () => {
    expect(detectVoiceCommand("SCRIBE STOP")).toBe("stop");
  });

  it("matches 'Scribe Redo.' (capital mid-word + period)", () => {
    expect(detectVoiceCommand("Scribe Redo.")).toBe("redo");
  });

  // Trailing punctuation variants observed in Gate 1
  it("strips trailing period: 'scribe stop.'", () => {
    expect(detectVoiceCommand("scribe stop.")).toBe("stop");
  });

  it("strips trailing exclamation: 'scribe clear!'", () => {
    expect(detectVoiceCommand("scribe clear!")).toBe("clear");
  });

  it("strips trailing comma: 'scribe submit,'", () => {
    expect(detectVoiceCommand("scribe submit,")).toBe("submit");
  });

  // Exact-segment: partial matches must NOT fire
  it("does not match mid-sentence: 'I should scribe clear that'", () => {
    expect(detectVoiceCommand("I should scribe clear that")).toBeNull();
  });

  it("does not match leading words: 'please scribe stop'", () => {
    expect(detectVoiceCommand("please scribe stop")).toBeNull();
  });

  it("does not match trailing words: 'scribe stop now'", () => {
    expect(detectVoiceCommand("scribe stop now")).toBeNull();
  });

  // False-positive surface — words that contain "scribe" must not match
  it("does not match 'describe stop'", () => {
    expect(detectVoiceCommand("describe stop")).toBeNull();
  });

  it("does not match 'subscribe clear'", () => {
    expect(detectVoiceCommand("subscribe clear")).toBeNull();
  });

  it("does not match 'subscriber submit'", () => {
    expect(detectVoiceCommand("subscriber submit")).toBeNull();
  });

  // Edge cases
  it("returns null for empty string", () => {
    expect(detectVoiceCommand("")).toBeNull();
  });

  it("returns null for unrelated text", () => {
    expect(detectVoiceCommand("Hello world")).toBeNull();
  });

  it("returns null for standalone 'scribe'", () => {
    expect(detectVoiceCommand("scribe")).toBeNull();
  });
});
