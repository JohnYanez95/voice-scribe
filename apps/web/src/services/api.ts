import type {
  HealthResponse,
  ModelListResponse,
  ModelSwapResponse,
  TranscribeResponse,
  WsCompleteMessage,
  WsMessage,
} from "../types";

const API_PORT = import.meta.env.VITE_API_PORT || "8084";
const BASE_URL = `http://localhost:${API_PORT}`;
const WS_BASE_URL = `ws://localhost:${API_PORT}`;

function blobFilename(blob: Blob): string {
  const base = blob.type.split(";")[0].trim();
  const EXT: Record<string, string> = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/mp4": ".mp4",
    "audio/mpeg": ".mp3",
  };
  return `recording${EXT[base] || ".webm"}`;
}

export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) {
    throw new Error(`Health check failed: ${res.status}`);
  }
  return res.json();
}

export async function transcribeAudio(
  blob: Blob,
  language?: string
): Promise<TranscribeResponse> {
  const formData = new FormData();
  formData.append("file", blob, blobFilename(blob));
  if (language) {
    formData.append("language", language);
  }

  const res = await fetch(`${BASE_URL}/transcribe`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: "Transcription failed" }));
    throw new Error(error.detail || `Transcription failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Open a WebSocket to /ws/transcribe and stream transcription segments.
 *
 * Two distinct failure classes:
 *   onConnectionError  — ws.onerror: connection-level failure (server unreachable,
 *                        network dropped). HTTP POST fallback is appropriate.
 *   onApplicationError — {"type": "error"} message: server hit an inference or
 *                        transcode error. The same error will occur on HTTP POST;
 *                        surface immediately, do not fall back.
 *
 * Returns a cleanup function that closes the WebSocket when called.
 */
export function streamTranscribeAudio(
  blob: Blob,
  onSegment: (text: string) => void,
  onComplete: (result: WsCompleteMessage) => void,
  onConnectionError: () => void,
  onApplicationError: (detail: string) => void,
  language?: string
): () => void {
  const url = new URL(`${WS_BASE_URL}/ws/transcribe`);
  if (language) url.searchParams.set("language", language);
  if (blob.type) {
    url.searchParams.set("audio_format", blob.type.split(";")[0].trim());
  }

  const ws = new WebSocket(url.toString());
  ws.binaryType = "blob";

  ws.onopen = () => ws.send(blob);

  ws.onmessage = (event) => {
    const msg: WsMessage = JSON.parse(event.data as string);
    if (msg.type === "segment") onSegment(msg.text);
    else if (msg.type === "complete") onComplete(msg);
    else if (msg.type === "error") onApplicationError(msg.detail);
  };

  ws.onerror = () => onConnectionError();

  return () => ws.close();
}

export async function listModels(): Promise<ModelListResponse> {
  const res = await fetch(`${BASE_URL}/models`);
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status}`);
  }
  return res.json();
}

export async function swapModel(modelName: string): Promise<ModelSwapResponse> {
  const res = await fetch(`${BASE_URL}/models/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: modelName }),
  });
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ detail: "Model swap failed" }));
    throw new Error(error.detail || `Model swap failed: ${res.status}`);
  }
  return res.json();
}
