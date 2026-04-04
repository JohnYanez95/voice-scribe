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

export interface ModelInfo {
  name: string;
  is_current: boolean;
}

export interface ModelListResponse {
  models: ModelInfo[];
  current_model: string;
}

export interface ModelSwapResponse {
  previous_model: string;
  current_model: string;
  swap_duration: number;
}

export interface WsSegmentMessage {
  type: "segment";
  text: string;
}

export interface WsCompleteMessage extends TranscribeResponse {
  type: "complete";
}

export interface WsErrorMessage {
  type: "error";
  detail: string;
}

export type WsMessage = WsSegmentMessage | WsCompleteMessage | WsErrorMessage;
