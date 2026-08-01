import { useCallback, useEffect, useRef, useState } from "react";
import { playCopySound } from "../../services/audio";
import { writeClipboard } from "../../services/platform";

interface TranscriptProps {
  text: string;
  rawText: string;
  isLoading: boolean;
  onTextChange: (text: string) => void;
  showComparison: boolean;
  isRecordingActive: boolean;
  /** Streaming (v4.1): committed raw text of the in-progress utterance.
   * Rendered in a read-only live region — never enters the textarea, so it
   * can never be edited, copied, or persisted (protocol C4.2 by construction).
   * Replaced by final.cleaned at utterance completion (C5.4: differs by
   * capitalization/whitespace only). */
  liveCommitted?: string;
  /** Streaming (v4.1): tentative tail — replaced wholesale per partial. */
  liveTail?: string;
}

/** Pixel tolerance for float-rounding in scrollTop comparisons. */
const SCROLL_THRESHOLD = 2;

export function Transcript({
  text,
  rawText,
  isLoading,
  onTextChange,
  showComparison,
  isRecordingActive,
  liveCommitted = "",
  liveTail = "",
}: TranscriptProps) {
  const [copied, setCopied] = useState<"" | "main" | "raw" | "cleaned">("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isPinnedRef = useRef(true);

  // Auto-scroll to bottom when text or live text changes, if pinned.
  useEffect(() => {
    const el = textareaRef.current;
    if (el && isPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, liveCommitted, liveTail]);

  // Re-engage pin when a new recording session starts.
  useEffect(() => {
    if (isRecordingActive) {
      isPinnedRef.current = true;
    }
  }, [isRecordingActive]);

  // onScroll: detect whether the user is at the bottom of the textarea.
  // Fires on both user scroll and programmatic scrollTop assignment.
  // Programmatic scroll lands at the bottom, so isPinned stays true — no conflict.
  const handleScroll = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
    isPinnedRef.current = atBottom;
  }, []);

  // onChange only fires on user input (keystrokes), never on React prop changes.
  // Unpin so the viewport stays where the user is editing — new segments arriving
  // via prop updates won't yank the scroll position away.
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      isPinnedRef.current = false;
      onTextChange(e.target.value);
    },
    [onTextChange]
  );

  const handleCopy = useCallback(async (content: string, source: "main" | "raw" | "cleaned") => {
    try {
      await writeClipboard(content);
      setCopied(source);
      setTimeout(() => setCopied(""), 2000);
      playCopySound().catch((err) => {
        console.error("[Transcript] audio playback failed:", err);
      });
    } catch (err) {
      console.error("[Transcript] clipboard write failed:", err);
    }
  }, []);

  const hasLive = Boolean(liveCommitted || liveTail);

  // Streaming mode never shows the spinner — the live region replaces it.
  if (isLoading && !text && !hasLive) {
    return (
      <div className="transcript">
        <div className="loading">Transcribing...</div>
      </div>
    );
  }

  if (!text && !hasLive) {
    return null;
  }

  const shouldShowComparison = showComparison && text;

  return (
    <div className="transcript">
      {shouldShowComparison && (
        <div className="comparison">
          <div className="comparison-pane">
            <div className="comparison-header">
              <label className="comparison-label">Raw</label>
              <button
                className="comparison-copy-btn"
                onClick={() => handleCopy(rawText, "raw")}
              >
                {copied === "raw" ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="comparison-text">{rawText}</div>
          </div>
          <div className="comparison-pane">
            <div className="comparison-header">
              <label className="comparison-label">Edit</label>
              <button
                className="comparison-copy-btn"
                onClick={() => handleCopy(text, "cleaned")}
              >
                {copied === "cleaned" ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="comparison-text">{text}</div>
          </div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onScroll={handleScroll}
        placeholder="Transcript will appear here..."
      />
      {hasLive && (
        <div className="transcript-live" data-testid="transcript-live">
          {/* aria-live on the committed span only: the tentative tail is
              wholesale-replaced per partial and would spam screen readers. */}
          <span aria-live="polite">{liveCommitted}</span>
          {liveTail && (
            <span className="tentative">
              {liveCommitted ? " " : ""}
              {liveTail}
            </span>
          )}
        </div>
      )}
      <button className="copy-btn" onClick={() => handleCopy(text, "main")}>
        {copied === "main" ? "Copied!" : "Copy to Clipboard"}
      </button>
    </div>
  );
}
