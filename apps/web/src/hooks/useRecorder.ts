import { useCallback, useEffect, useRef, useState } from "react";

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/ogg",
] as const;

export function negotiateMimeType(): string | null {
  for (const mime of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

interface UseRecorderResult {
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  audioBlob: Blob | null;
  isRecording: boolean;
  error: string | null;
}

export function useRecorder(): UseRecorderResult {
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mimeTypeRef = useRef<string>("");

  // Clean up media stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    setAudioBlob(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Negotiate a MIME type, falling back to browser default
      const mimeType = negotiateMimeType();
      let recorder: MediaRecorder;
      if (mimeType) {
        recorder = new MediaRecorder(stream, { mimeType });
      } else {
        recorder = new MediaRecorder(stream);
      }
      mimeTypeRef.current = recorder.mimeType;

      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
        if (blob.size === 0) {
          console.warn(
            "[useRecorder] empty recording — mimeType:", mimeTypeRef.current,
            "chunks:", chunksRef.current.length,
          );
        }
        setAudioBlob(blob);
        setIsRecording(false);

        // Stop all tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      recorder.onerror = () => {
        setError("Recording failed. Please try again.");
        setIsRecording(false);
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Microphone access denied. Please allow microphone access and try again.");
      } else if (err instanceof DOMException && err.name === "NotSupportedError") {
        setError(
          "No supported audio encoder found. On Linux, install gstreamer1.0-plugins-bad and restart."
        );
      } else {
        setError("Could not start recording. Check microphone permissions.");
      }
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  return { startRecording, stopRecording, audioBlob, isRecording, error };
}
