import { useCallback, useEffect, useRef, useState } from "react";

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
  const [copied, setCopied] = useState(false);
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

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for clipboard API failure
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

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

  const shouldShowComparison = showComparison && rawText && rawText !== text;

  return (
    <div className="transcript">
      {shouldShowComparison && (
        <div className="comparison">
          <div className="comparison-pane">
            <label className="comparison-label">Raw</label>
            <div className="comparison-text">{rawText}</div>
          </div>
          <div className="comparison-pane">
            <label className="comparison-label">Cleaned</label>
            <div className="comparison-text">{text}</div>
          </div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onScroll={handleScroll}
        rows={8}
        placeholder="Transcript will appear here..."
      />
      <button className="copy-btn" onClick={handleCopy}>
        {copied ? "Copied!" : "Copy to Clipboard"}
      </button>
    </div>
  );
}
