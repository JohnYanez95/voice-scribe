import type { HealthResponse, TranscribeResponse } from "../types";

const BASE_URL = "http://localhost:8000";

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
  formData.append("file", blob, "recording.webm");
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
