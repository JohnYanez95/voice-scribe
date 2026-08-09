/**
 * Persistent /ws/stream session client (protocol v1 + amendments,
 * docs/v4/protocol.md). One session spans a whole continuous-mode activation;
 * utterances are delimited by flush, not by connection churn.
 *
 * Deliberately independent of api.ts: that module is typed request/response,
 * this is a stateful lifecycle — and the degrade path (protocol §10) must
 * reuse the existing one-shot code unchanged, so this module never wraps it.
 */
import type {
  StreamErrorCode,
  WsStreamReadyMessage,
  WsStreamPartialMessage,
  WsStreamCommittedMessage,
  WsStreamFinalMessage,
  WsStreamErrorMessage,
  WsStreamServerMessage,
} from "../types";
import { clearWireLog, recordWire, recordWireFrameSent } from "./wireDebug";

const API_PORT = import.meta.env.VITE_API_PORT || "8084";
// Derive scheme and host from the page rather than hardcoding ws://localhost:
// over HTTPS a fixed ws:// is blocked as mixed content, and a fixed localhost
// breaks access from any other host. Local-first stays the default because the
// page itself is normally served from localhost.
const WS_SCHEME = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
const WS_HOST =
  typeof window !== "undefined" && window.location.hostname ? window.location.hostname : "localhost";
const WS_BASE_URL = `${WS_SCHEME}://${WS_HOST}:${API_PORT}`;

// Wire framing: fixed 1536-sample (96 ms, 6144-byte) frames — the profile
// stream_bench benched. vad-web's legacy model delivers exactly this size, so
// batching is a pass-through in the default configuration; the remainder is
// drained before flush/stop controls.
const WIRE_FRAME_SAMPLES = 1536;
// Ping only counts as needed when no frame went out recently (C3.8). The
// window is capped at a third of the ping interval so a short idle_timeout_s
// cannot suppress the ping past the server's deadline — see makeReady.
const PING_SUPPRESS_MS = 2000;
// A server may accept the socket and then never send `ready` (wedged model
// load, half-open connection). §1 gives the server an idle timeout but the
// client had no deadline of its own, so the session waited forever instead of
// degrading. Generous: model load on a cold cache is slow.
const READY_TIMEOUT_MS = 15000;
// A peer that never acks `stop` would leave the session in "stopping" and the
// caller waiting on onStopped forever. Stopping is what the user asked for, so
// on expiry we complete rather than degrade.
const STOP_ACK_TIMEOUT_MS = 5000;

export type DegradeReason =
  | { kind: "connect_failed" }
  | { kind: "fatal_error"; code: StreamErrorCode; detail: string }
  | { kind: "closed"; closeCode?: number };

export interface StreamSessionCallbacks {
  onReady?: (msg: WsStreamReadyMessage) => void;
  /** Stale utterance_ids are already filtered (protocol §4). */
  onPartial: (msg: WsStreamPartialMessage) => void;
  onCommitted: (msg: WsStreamCommittedMessage) => void;
  onFinal: (msg: WsStreamFinalMessage) => void;
  /** §10/C10.2: fall back to the one-shot path, permanent for this session. */
  onDegrade: (reason: DegradeReason) => void;
  /** decode_failure only — surfacing, never fallback (C10.2). */
  onSurfaceError: (detail: string) => void;
  onNonFatal?: (msg: WsStreamErrorMessage) => void;
  /** stop acked / clean close. */
  onStopped?: () => void;
}

export interface StreamSession {
  /** Queue speech PCM (any length; coalesced to wire frames). No-op after stop. */
  sendAudio(samples: Float32Array): void;
  /** Utterance boundary (C3.3) — drains pending audio first. */
  flush(): void;
  /** Destructive drop of the current utterance (C3.6) — used on VAD misfire. */
  reset(): void;
  /** Session end (C3.5): drain, stop, await ack; server closes 1000. */
  stop(): void;
  /** Hard teardown (unmount) — no handshake, idempotent. */
  close(): void;
  /** Seconds since the session opened (C1.6 rotation is the caller's job). */
  age(): number;
  readonly state: "connecting" | "open" | "stopping" | "closed";
}

export function openStreamSession(
  opts: { language?: string },
  cb: StreamSessionCallbacks
): StreamSession {
  let state: StreamSession["state"] = "connecting";
  let ready = false;
  clearWireLog(); // dev mode: one capture per session, memory-only
  let degradeFired = false;
  let maxUtteranceId = 0;
  let lastSeq = 0;
  let lastFrameSentAt = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  const openedAt = Date.now();

  const pending: Float32Array[] = [];
  let pendingSamples = 0;

  const ws = new WebSocket(`${WS_BASE_URL}/ws/stream`);
  ws.binaryType = "arraybuffer";

  const clearPing = () => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const clearReadyTimer = () => {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  };

  const clearStopTimer = () => {
    if (stopTimer !== null) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  };

  const teardown = () => {
    state = "closed";
    clearPing();
    clearReadyTimer();
    clearStopTimer();
    pending.length = 0;
    pendingSamples = 0;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  };

  const degrade = (reason: DegradeReason) => {
    if (degradeFired || state === "closed") return;
    degradeFired = true;
    teardown();
    cb.onDegrade(reason);
  };

  // Armed at construction, not in onopen: a connect that stalls in CONNECTING
  // never fires onopen, so arming there left exactly the case this guard exists
  // for — a socket that never becomes usable — with no deadline at all. Covers
  // both stalls now: never opens, and opens but never sends `ready`.
  readyTimer = setTimeout(() => {
    if (ready || state === "closed") return;
    // eslint-disable-next-line no-console
    console.error("stream: no ready within timeout — degrading to one-shot");
    degrade({ kind: "connect_failed" });
  }, READY_TIMEOUT_MS);

  const sendControl = (msg: Record<string, unknown>) => {
    recordWire("out", msg);
    ws.send(JSON.stringify(msg));
  };

  const sendWireFrame = (samples: Float32Array) => {
    recordWireFrameSent(samples.byteLength); // aggregate only — never PCM
    // Copy the frame's byte range, don't send a live view: these samples are
    // views into buffers the VAD reuses, and send() flushes asynchronously.
    // The copy goes through a typed array because TypedArray.buffer widened to
    // ArrayBufferLike in TS 5.7+, and send() rejects the SharedArrayBuffer half;
    // slice() on the view yields a fresh ArrayBuffer-backed copy.
    ws.send(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength).slice().buffer);
    lastFrameSentAt = Date.now();
  };

  /** Emit full wire frames; with drainAll, also the sub-frame remainder. */
  const drainPending = (drainAll: boolean) => {
    while (pendingSamples >= WIRE_FRAME_SAMPLES) {
      const out = new Float32Array(WIRE_FRAME_SAMPLES);
      let filled = 0;
      while (filled < WIRE_FRAME_SAMPLES) {
        const head = pending[0];
        const take = Math.min(head.length, WIRE_FRAME_SAMPLES - filled);
        out.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) pending.shift();
        else pending[0] = head.subarray(take);
      }
      pendingSamples -= WIRE_FRAME_SAMPLES;
      sendWireFrame(out);
    }
    if (drainAll && pendingSamples > 0) {
      const out = new Float32Array(pendingSamples);
      let filled = 0;
      for (const chunk of pending) {
        out.set(chunk, filled);
        filled += chunk.length;
      }
      pending.length = 0;
      pendingSamples = 0;
      sendWireFrame(out);
    }
  };

  const handleError = (msg: WsStreamErrorMessage) => {
    if (!msg.fatal) {
      // eslint-disable-next-line no-console
      console.warn(`stream: non-fatal ${msg.code}: ${msg.detail}`);
      cb.onNonFatal?.(msg);
      return;
    }
    if (msg.code === "decode_failure") {
      // Same failure recurs on the one-shot path — surface, never fall back.
      teardown();
      cb.onSurfaceError(msg.detail);
      return;
    }
    // Default rule (C10.2): every other fatal code — including codes unknown
    // to this client — degrades silently; client-bug classes stay loud in the
    // console but never become a user-facing error state.
    // eslint-disable-next-line no-console
    console.error(`stream: fatal ${msg.code}: ${msg.detail} — degrading to one-shot`);
    degrade({ kind: "fatal_error", code: msg.code, detail: msg.detail });
  };

  ws.onopen = () => {
    sendControl({
      type: "start",
      protocol_version: 1,
      sample_format: "pcm_f32le",
      sample_rate: 16000,
      ...(opts.language ? { language: opts.language } : {}),
    });
  };

  ws.onmessage = (event) => {
    if (state === "closed") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      return;
    }
    // JSON.parse accepts null, arrays and scalars. Reading .seq/.type off those
    // throws inside the handler; drop them and keep the session open — a peer
    // sending junk is not a reason to lose a live capture session.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    const msg = parsed as WsStreamServerMessage;
    // Dev mode: capture BEFORE the §4 stale filter — a message dropped as
    // stale is exactly what the diagnostic exists to see.
    recordWire("in", msg as unknown as Record<string, unknown>);
    if (msg.seq !== undefined) {
      if (msg.seq < lastSeq) {
        // eslint-disable-next-line no-console
        console.warn(`stream: seq regression ${lastSeq} -> ${msg.seq}`);
      }
      lastSeq = msg.seq;
    }

    if (!ready) {
      if (msg.type === "ready") {
        ready = true;
        state = "open";
        clearReadyTimer();
        // Arm the keepalive AT ready (a session opened and left silent must
        // survive the idle timeout), and only when the server advertises it —
        // a v4.0 server would fatally reject ping (C3.8 skew guard).
        lastFrameSentAt = Date.now();
        const idleS = msg.idle_timeout_s;
        if (typeof idleS === "number" && idleS > 0) {
          const intervalMs = (idleS * 1000) / 3;
          // Never suppress for longer than the interval itself: with a small
          // idle_timeout_s a fixed 2 s window would skip every ping and the
          // server would time the session out mid-silence.
          const suppressMs = Math.min(PING_SUPPRESS_MS, intervalMs);
          pingTimer = setInterval(() => {
            if (state !== "open") return;
            if (Date.now() - lastFrameSentAt > suppressMs) {
              sendControl({ type: "ping" });
            }
          }, intervalMs);
        }
        cb.onReady?.(msg);
      } else if (msg.type === "error") {
        handleError(msg as WsStreamErrorMessage);
      }
      return;
    }

    switch (msg.type) {
      case "partial":
      case "committed":
      case "final": {
        if (msg.utterance_id < maxUtteranceId) return; // §4 stale filter
        maxUtteranceId = msg.utterance_id;
        if (msg.type === "partial") cb.onPartial(msg);
        else if (msg.type === "committed") cb.onCommitted(msg);
        else cb.onFinal(msg);
        return;
      }
      case "error":
        handleError(msg);
        return;
      case "ack":
        // C4.6 uniform rule: the ack carries the id in force after the
        // control — adopt it so stale messages from before a reset drop.
        maxUtteranceId = Math.max(maxUtteranceId, msg.utterance_id);
        if (msg.of === "stop") {
          const wasStopping = state === "stopping";
          teardown();
          if (wasStopping) cb.onStopped?.();
          // A stop ack we did not ask for means the server ended the session
          // out from under us; the caller must fall back rather than sit on a
          // dead socket believing it is live.
          else cb.onDegrade({ kind: "closed" });
        }
        return;
      default:
        return;
    }
  };

  ws.onerror = () => {
    if (!ready) degrade({ kind: "connect_failed" });
  };

  ws.onclose = (event) => {
    clearPing();
    if (state === "closed") return;
    if (!ready) {
      // C1.2: pre-accept closes (origin, stale server) look like this.
      degrade({ kind: "connect_failed" });
      return;
    }
    if (state === "stopping") {
      // Server closed 1000 after the stop ack path raced the close.
      teardown();
      cb.onStopped?.();
      return;
    }
    degrade({ kind: "closed", closeCode: event.code });
  };

  return {
    sendAudio(samples: Float32Array) {
      if (state !== "open" || !ready) return; // incl. explicit no-op post-stop
      // Copy at the QUEUE boundary, not at the send boundary. These arrays are
      // views into a buffer vad-web reuses (see useVAD's frame tap); a
      // sub-frame remainder can sit in `pending` across several VAD callbacks,
      // and would mutate underneath us before reaching the wire. Transmitted
      // audio must equal captured audio.
      pending.push(new Float32Array(samples));
      pendingSamples += samples.length;
      drainPending(false);
    },
    flush() {
      if (state !== "open" || !ready) return;
      drainPending(true);
      sendControl({ type: "flush" });
    },
    reset() {
      if (state !== "open" || !ready) return;
      pending.length = 0;
      pendingSamples = 0;
      sendControl({ type: "reset" });
    },
    stop() {
      if (state !== "open" || !ready) {
        // Stopping a session that never opened still completes: callers gate
        // their "done" transition on onStopped, and without this they wait on
        // a callback that can no longer arrive.
        const wasClosed = state === "closed";
        teardown();
        if (!wasClosed) cb.onStopped?.();
        return;
      }
      drainPending(true);
      state = "stopping";
      clearPing();
      sendControl({ type: "stop" });
      stopTimer = setTimeout(() => {
        if (state !== "stopping") return;
        // eslint-disable-next-line no-console
        console.error("stream: no stop ack within timeout — completing anyway");
        teardown();
        cb.onStopped?.();
      }, STOP_ACK_TIMEOUT_MS);
    },
    close() {
      if (state === "closed") return;
      teardown();
    },
    age() {
      return (Date.now() - openedAt) / 1000;
    },
    get state() {
      return state;
    },
  };
}
