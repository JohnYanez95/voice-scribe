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
}: TranscriptProps) {
  const [copied, setCopied] = useState<"" | "main" | "raw" | "cleaned">("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isPinnedRef = useRef(true);

  // Auto-scroll to bottom when text changes, if pinned.
  useEffect(() => {
    const el = textareaRef.current;
    if (el && isPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

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

  if (isLoading && !text) {
    return (
      <div className="transcript">
        <div className="loading">Transcribing...</div>
      </div>
    );
  }

  if (!text) {
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
      <button className="copy-btn" onClick={() => handleCopy(text, "main")}>
        {copied === "main" ? "Copied!" : "Copy to Clipboard"}
      </button>
    </div>
  );
}
