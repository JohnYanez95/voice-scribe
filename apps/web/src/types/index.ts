export type RecordingState =
  | "idle"
  | "recording"
  | "listening"
  | "streaming"
  | "processing"
  | "done"
  | "error";

export type RecordingMode = "push-to-talk" | "continuous";

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

// --- /ws/stream protocol v1 (docs/v4/protocol.md) — mirrors app/schemas.py ---

// Known codes are exhaustive as of protocol v1 (docs/v4/protocol.md §8). The
// open form below keeps an unknown code from a newer server representable
// rather than a type error — the client's rule is to honor `fatal`, not to
// recognize the code, so an unrecognized fatal must still degrade.
export type KnownStreamErrorCode =
  | "busy"
  | "preempted"
  | "protocol_violation"
  | "frame_too_large"
  | "unsupported_format"
  | "unsupported_version"
  | "model_swapping"
  | "decode_failure"
  | "overrun"
  | "session_timeout";

export type StreamErrorCode = KnownStreamErrorCode | (string & {});

export interface WsStreamReadyMessage {
  type: "ready";
  seq: number;
  protocol_version: number;
  session_id: string;
  sample_rate: number;
  sample_format: string;
  max_frame_bytes: number;
  model_name: string;
  language: string | null;
  decode_tick_ms: number;
  max_uncommitted_s: number;
  max_holdback_ticks: number;
  /** C3.8 capability signal — absent on a v4.0 server; ping only when present. */
  idle_timeout_s?: number;
}

/** C4.2: text REPLACES the entire tentative tail. Never persist, copy,
 * transform, or act on partial text. */
export interface WsStreamPartialMessage {
  type: "partial";
  seq: number;
  utterance_id: number;
  text: string;
}

/** C4.3: append-only delta; t0/t1 are received-audio seconds within the
 * utterance. forced marks a holdback force-commit. */
export interface WsStreamCommittedMessage {
  type: "committed";
  seq: number;
  utterance_id: number;
  text: string;
  t0: number;
  t1: number;
  forced: boolean;
}

/** C4.4: raw carries the utterance's committed text as a literal prefix.
 * Release signal for the retained utterance PCM (C10.3). */
export interface WsStreamFinalMessage {
  type: "final";
  seq: number;
  utterance_id: number;
  raw: string;
  cleaned: string;
  language: string;
  duration: number;
  model_name: string;
  processing_mode: string;
  dropped_audio_ms: number;
  forced: boolean;
}

export interface WsStreamErrorMessage {
  type: "error";
  seq: number;
  code: StreamErrorCode;
  detail: string;
  fatal: boolean;
}

/** C4.6: utterance_id is the id in force AFTER the control was applied. */
export interface WsStreamAckMessage {
  type: "ack";
  seq: number;
  of: "stop" | "reset";
  utterance_id: number;
}

export type WsStreamServerMessage =
  | WsStreamReadyMessage
  | WsStreamPartialMessage
  | WsStreamCommittedMessage
  | WsStreamFinalMessage
  | WsStreamErrorMessage
  | WsStreamAckMessage;
