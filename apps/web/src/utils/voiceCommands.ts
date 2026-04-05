export type VoiceCommandKey = "copy" | "clear";

// Lookup table — extensible. Adding a third command is one entry here.
const COMMAND_MAP: Record<string, VoiceCommandKey> = {
  "copy":  "copy",
  "clear": "clear",
};

// Normalize: trim whitespace, lowercase, strip trailing punctuation.
// Handles "Scribe stop." (Whisper's capitalized first letter + period/exclamation).
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?,]+$/, "").trim();
}

/**
 * Detects whether an entire transcript segment is a voice command.
 *
 * Matching is exact-segment: the full normalized segment must equal a command
 * phrase. Partial matches ("please scribe stop", "I should scribe clear that")
 * return null. If the segment is a command, the entire segment is consumed —
 * there is nothing to display and nothing to strip.
 */
export function detectVoiceCommand(text: string): VoiceCommandKey | null {
  return COMMAND_MAP[normalize(text)] ?? null;
}
