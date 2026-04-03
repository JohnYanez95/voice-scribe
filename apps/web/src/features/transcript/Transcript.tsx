import { useCallback, useState } from "react";

interface TranscriptProps {
  text: string;
  isLoading: boolean;
  onTextChange: (text: string) => void;
}

export function Transcript({ text, isLoading, onTextChange }: TranscriptProps) {
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

  return (
    <div className="transcript">
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
