import { useRef, useState, useEffect } from "react";
import { MicVAD } from "@ricky0123/vad-web";

const ONNX_WASM_BASE_PATH = "/node_modules/onnxruntime-web/dist/";

export interface UseVADOptions {
  onSpeechStart?: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
}

export interface UseVADResult {
  startListening: () => Promise<void>;
  stopListening: () => void;
  isListening: boolean;
  error: string | null;
}

export function useVAD(options: UseVADOptions): UseVADResult {
  const vadRef = useRef<Awaited<ReturnType<typeof MicVAD.new>> | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable callback refs — updated on every render so callbacks inside
  // the VAD closure always see the current version without stale captures.
  const onSpeechStartRef = useRef(options.onSpeechStart);
  const onSpeechEndRef = useRef(options.onSpeechEnd);
  useEffect(() => {
    onSpeechStartRef.current = options.onSpeechStart;
    onSpeechEndRef.current = options.onSpeechEnd;
  });

  // Destroy VAD instance on unmount.
  useEffect(() => {
    return () => {
      vadRef.current?.destroy();
    };
  }, []);

  const startListening = async (): Promise<void> => {
    // Destroy any previous paused instance before creating a new one.
    // Without this, repeated start/stop cycles orphan MicVAD instances
    // (ONNX runtime + AudioWorklet + MediaStream) until component unmount.
    vadRef.current?.destroy();
    try {
      const vad = await MicVAD.new({
        baseAssetPath: "/",
        onnxWASMBasePath: ONNX_WASM_BASE_PATH,
        onSpeechStart: () => {
          onSpeechStartRef.current?.();
        },
        onSpeechEnd: (audio: Float32Array) => {
          onSpeechEndRef.current(audio);
        },
      });
      vadRef.current = vad;
      await vad.start();
      setIsListening(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "VAD initialization failed";
      setError(message);
    }
  };

  const stopListening = (): void => {
    if (vadRef.current) {
      vadRef.current.pause();
      setIsListening(false);
    }
  };

  return { startListening, stopListening, isListening, error };
}
