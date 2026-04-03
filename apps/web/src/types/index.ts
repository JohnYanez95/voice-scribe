export type RecordingState = "idle" | "recording" | "processing" | "done" | "error";

export interface TranscribeResponse {
  raw: string;
  cleaned: string;
  language: string;
  duration: number;
  processing_mode: string;
  model_name: string;
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  device: string;
  model_name: string;
}
