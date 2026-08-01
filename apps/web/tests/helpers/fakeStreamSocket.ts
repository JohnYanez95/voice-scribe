/** WebSocket-level fake for /ws/stream client tests. First WS fake in the
 * suite — streamSession tests drive it directly; App-level tests mock the
 * streamSession module instead (same style as the api.ts module mocks). */
import { vi } from "vitest";
import type { WsStreamServerMessage } from "../../src/types";

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }

  url: string;
  binaryType = "blob";
  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  /** JSON.parsed text sends, in order. */
  sentControls: Array<Record<string, unknown>> = [];
  /** Binary sends, in order. */
  sentFrames: ArrayBuffer[] = [];
  clientCloseCodes: number[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === "string") this.sentControls.push(JSON.parse(data));
    else this.sentFrames.push(data);
  }

  close(code = 1000) {
    this.clientCloseCodes.push(code);
    this.readyState = 3; // CLOSED
  }

  // ---- server-side drivers ----
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverMessage(msg: WsStreamServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  serverError() {
    this.onerror?.({});
  }

  /** All frames as one Float32Array, for content assertions. */
  sentSamples(): Float32Array {
    const total = this.sentFrames.reduce((n, b) => n + b.byteLength / 4, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const buf of this.sentFrames) {
      out.set(new Float32Array(buf), at);
      at += buf.byteLength / 4;
    }
    return out;
  }
}

export function installFakeWebSocket() {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

// ---- schema-correct message factories (seq auto-increments per suite) ----
let seq = 0;
export function resetSeq() {
  seq = 0;
}
export const makeReady = (
  over: Partial<Extract<WsStreamServerMessage, { type: "ready" }>> = {}
): WsStreamServerMessage => ({
  type: "ready",
  seq: ++seq,
  protocol_version: 1,
  session_id: "s-test",
  sample_rate: 16000,
  sample_format: "pcm_f32le",
  max_frame_bytes: 65536,
  model_name: "large-v3",
  language: null,
  decode_tick_ms: 750,
  max_uncommitted_s: 24,
  max_holdback_ticks: 6,
  idle_timeout_s: 10,
  ...over,
});
export const makePartial = (utterance_id: number, text: string): WsStreamServerMessage => ({
  type: "partial",
  seq: ++seq,
  utterance_id,
  text,
});
export const makeCommitted = (
  utterance_id: number,
  text: string,
  over: Partial<Extract<WsStreamServerMessage, { type: "committed" }>> = {}
): WsStreamServerMessage => ({
  type: "committed",
  seq: ++seq,
  utterance_id,
  text,
  t0: 0,
  t1: 1,
  forced: false,
  ...over,
});
export const makeFinal = (
  utterance_id: number,
  raw: string,
  over: Partial<Extract<WsStreamServerMessage, { type: "final" }>> = {}
): WsStreamServerMessage => ({
  type: "final",
  seq: ++seq,
  utterance_id,
  raw,
  cleaned: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) + "." : "",
  language: "en",
  duration: 2.5,
  model_name: "large-v3",
  processing_mode: "stream",
  dropped_audio_ms: 0,
  forced: false,
  ...over,
});
export const makeError = (
  code: Extract<WsStreamServerMessage, { type: "error" }>["code"],
  fatal: boolean,
  detail = "detail"
): WsStreamServerMessage => ({ type: "error", seq: ++seq, code, detail, fatal });
export const makeAck = (of: "stop" | "reset", utterance_id: number): WsStreamServerMessage => ({
  type: "ack",
  seq: ++seq,
  of,
  utterance_id,
});
