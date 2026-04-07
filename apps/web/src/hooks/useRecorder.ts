import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav } from "../utils/audio";

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

  // MediaRecorder path refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");

  // ScriptProcessorNode fallback path refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);

  // Shared
  const streamRef = useRef<MediaStream | null>(null);

  // Clean up all resources on unmount
  useEffect(() => {
    return () => {
      if (scriptNodeRef.current) {
        scriptNodeRef.current.disconnect();
        scriptNodeRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  function stopAndFinalizePcm() {
    if (scriptNodeRef.current) {
      scriptNodeRef.current.disconnect();
      scriptNodeRef.current = null;
    }

    const sampleRate = audioContextRef.current?.sampleRate ?? 48000;

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    const chunks = pcmChunksRef.current;
    pcmChunksRef.current = [];
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    if (totalLength === 0) {
      console.warn("[useRecorder] PCM fallback produced empty recording");
    }

    const samples = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    const blob = encodeWav(samples, sampleRate);
    setAudioBlob(blob);
    setIsRecording(false);
  }

  const startRecording = useCallback(async () => {
    setError(null);
    setAudioBlob(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = negotiateMimeType();

      if (mimeType) {
        // ── MediaRecorder path ──────────────────────────────────
        const recorder = new MediaRecorder(stream, { mimeType });
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
      } else {
        // ── ScriptProcessorNode fallback (no working encoder) ──
        console.warn(
          "[useRecorder] MediaRecorder has no supported MIME type — using ScriptProcessorNode PCM fallback"
        );

        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        pcmChunksRef.current = [];

        const source = audioContext.createMediaStreamSource(stream);
        const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
        scriptNodeRef.current = scriptNode;

        scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
          const input = event.inputBuffer.getChannelData(0);
          pcmChunksRef.current.push(new Float32Array(input));
        };

        source.connect(scriptNode);
        // Must connect to destination for onaudioprocess to fire; outputs silence.
        scriptNode.connect(audioContext.destination);
      }

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
    } else if (audioContextRef.current) {
      stopAndFinalizePcm();
    }
  }, []);

  return { startRecording, stopRecording, audioBlob, isRecording, error };
}
