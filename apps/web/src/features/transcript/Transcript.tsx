import { useCallback, useState } from "react";

interface TranscriptProps {
  text: string;
  rawText: string;
  isLoading: boolean;
  onTextChange: (text: string) => void;
}

export function Transcript({ text, rawText, isLoading, onTextChange }: TranscriptProps) {
  const [copied, setCopied] = useState(false);

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

  if (isLoading) {
    return (
      <div className="transcript">
        <div className="loading">Transcribing...</div>
      </div>
    );
  }

  if (!text) {
    return null;
  }

  const showComparison = rawText && rawText !== text;

  return (
    <div className="transcript">
      {showComparison && (
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
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={8}
        placeholder="Transcript will appear here..."
      />
      <button className="copy-btn" onClick={handleCopy}>
        {copied ? "Copied!" : "Copy to Clipboard"}
      </button>
    </div>
  );
}
