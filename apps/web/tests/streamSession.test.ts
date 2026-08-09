import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FakeWebSocket,
  installFakeWebSocket,
  resetSeq,
  makeReady,
  makePartial,
  makeCommitted,
  makeFinal,
  makeError,
  makeAck,
} from "./helpers/fakeStreamSocket";
import { openStreamSession } from "../src/services/streamSession";
import type { WsStreamServerMessage } from "../src/types";
import type { StreamSessionCallbacks } from "../src/services/streamSession";

function makeCallbacks(): StreamSessionCallbacks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onReady: vi.fn(),
    onPartial: vi.fn(),
    onCommitted: vi.fn(),
    onFinal: vi.fn(),
    onDegrade: vi.fn(),
    onSurfaceError: vi.fn(),
    onNonFatal: vi.fn(),
    onStopped: vi.fn(),
  };
}

function openReadySession(cb = makeCallbacks(), readyOverrides = {}) {
  const session = openStreamSession({}, cb);
  const ws = FakeWebSocket.instances[0];
  ws.serverOpen();
  ws.serverMessage(makeReady(readyOverrides));
  return { session, ws, cb };
}

const samples = (n: number, fill = 0.1) => new Float32Array(n).fill(fill);

beforeEach(() => {
  vi.useFakeTimers();
  installFakeWebSocket();
  resetSeq();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handshake (C3.1/C4.1)", () => {
  it("sends start on open with protocol v1 / pcm_f32le / 16000", () => {
    const cb = makeCallbacks();
    openStreamSession({ language: "en" }, cb);
    const ws = FakeWebSocket.instances[0];
    expect(ws.sentControls).toHaveLength(0); // nothing before open
    ws.serverOpen();
    expect(ws.sentControls[0]).toEqual({
      type: "start",
      protocol_version: 1,
      sample_format: "pcm_f32le",
      sample_rate: 16000,
      language: "en",
    });
  });

  it("no frames hit the wire before ready", () => {
    const cb = makeCallbacks();
    const session = openStreamSession({}, cb);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    session.sendAudio(samples(1536));
    expect(ws.sentFrames).toHaveLength(0);
    ws.serverMessage(makeReady());
    expect(cb.onReady).toHaveBeenCalledOnce();
    expect(session.state).toBe("open");
  });

  it("failure before ready degrades as connect_failed (server error)", () => {
    const cb = makeCallbacks();
    openStreamSession({}, cb);
    FakeWebSocket.instances[0].serverError();
    expect(cb.onDegrade).toHaveBeenCalledWith({ kind: "connect_failed" });
  });

  it("close before ready degrades as connect_failed (C1.2 pre-accept close)", () => {
    const cb = makeCallbacks();
    openStreamSession({}, cb);
    FakeWebSocket.instances[0].serverClose(1006);
    expect(cb.onDegrade).toHaveBeenCalledWith({ kind: "connect_failed" });
    expect(cb.onDegrade).toHaveBeenCalledOnce(); // error+close never double-fire
  });
});

describe("wire framing", () => {
  it("coalesces to uniform 1536-sample frames", () => {
    const { session, ws } = openReadySession();
    session.sendAudio(samples(512, 0.1));
    session.sendAudio(samples(512, 0.2));
    expect(ws.sentFrames).toHaveLength(0); // sub-frame: pending
    session.sendAudio(samples(512, 0.3));
    expect(ws.sentFrames).toHaveLength(1);
    expect(ws.sentFrames[0].byteLength).toBe(1536 * 4);
  });

  it("passes 1536-sample input straight through (legacy-model profile)", () => {
    const { session, ws } = openReadySession();
    session.sendAudio(samples(1536));
    expect(ws.sentFrames).toHaveLength(1);
    expect(ws.sentFrames[0].byteLength).toBe(1536 * 4);
  });

  it("flush drains the sub-frame remainder before the control (order asserted)", () => {
    const { session, ws } = openReadySession();
    session.sendAudio(samples(2000));
    expect(ws.sentFrames).toHaveLength(1); // 1536 out, 464 pending
    session.flush();
    expect(ws.sentFrames).toHaveLength(2);
    expect(ws.sentFrames[1].byteLength).toBe(464 * 4);
    expect(ws.sentControls.at(-1)).toEqual({ type: "flush" });
  });

  it("a 9-frame pre-roll burst goes out as 9 uniform frames, all under the cap", () => {
    const { session, ws } = openReadySession();
    for (let i = 0; i < 9; i++) session.sendAudio(samples(1536, i / 10));
    expect(ws.sentFrames).toHaveLength(9);
    for (const f of ws.sentFrames) {
      expect(f.byteLength).toBe(6144);
      expect(f.byteLength).toBeLessThanOrEqual(65536);
    }
  });

  it("sample content survives coalescing intact", () => {
    const { session, ws } = openReadySession();
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array(1533).fill(9);
    const c = new Float32Array([4, 5]);
    session.sendAudio(a);
    session.sendAudio(b);
    session.sendAudio(c);
    session.flush();
    const all = ws.sentSamples();
    expect(all.length).toBe(1538);
    expect([all[0], all[1], all[2]]).toEqual([1, 2, 3]);
    expect(all[3]).toBe(9);
    expect([all[1536], all[1537]]).toEqual([4, 5]);
  });
});

describe("ping keepalive (C3.8)", () => {
  it("pings within 5 s of ready with zero frames sent", () => {
    const { ws } = openReadySession(); // idle_timeout_s: 10 → period 3.33 s
    vi.advanceTimersByTime(5000);
    expect(ws.sentControls.filter((c) => c.type === "ping").length).toBeGreaterThanOrEqual(1);
  });

  it("never pings when ready lacks idle_timeout_s (v4.0 server skew guard)", () => {
    const { ws } = openReadySession(makeCallbacks(), { idle_timeout_s: undefined });
    vi.advanceTimersByTime(30_000);
    expect(ws.sentControls.filter((c) => c.type === "ping")).toHaveLength(0);
  });

  it("suppresses pings while frames are flowing", () => {
    const { session, ws } = openReadySession();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1000);
      session.sendAudio(samples(1536));
    }
    expect(ws.sentControls.filter((c) => c.type === "ping")).toHaveLength(0);
  });

  it("stops pinging after close", () => {
    const { session, ws } = openReadySession();
    session.close();
    vi.advanceTimersByTime(30_000);
    expect(ws.sentControls.filter((c) => c.type === "ping")).toHaveLength(0);
  });
});

describe("utterance_id and seq handling (§4)", () => {
  it("drops stale utterance_id messages, passes current ones", () => {
    const { ws, cb } = openReadySession();
    ws.serverMessage(makePartial(1, "current"));
    ws.serverMessage(makePartial(0, "stale"));
    ws.serverMessage(makeCommitted(1, "kept"));
    expect(cb.onPartial).toHaveBeenCalledOnce();
    expect(cb.onPartial.mock.calls[0][0].text).toBe("current");
    expect(cb.onCommitted).toHaveBeenCalledOnce();
  });

  it("adopts the reset ack's post-bump id (C4.6) so pre-reset messages drop", () => {
    const { session, ws, cb } = openReadySession();
    ws.serverMessage(makePartial(0, "before reset"));
    session.reset();
    ws.serverMessage(makeAck("reset", 1));
    ws.serverMessage(makePartial(0, "in-flight from old utterance"));
    ws.serverMessage(makePartial(1, "new utterance"));
    expect(cb.onPartial.mock.calls.map((c) => c[0].text)).toEqual([
      "before reset",
      "new utterance",
    ]);
  });

  // Both halves of the same failure: Math.max against a non-number yields NaN,
  // and every later `<` against NaN is false, so the filter keeps running and
  // silently stops dropping anything. Missing is as damaging as malformed.
  it.each([
    ["missing", undefined],
    ["non-numeric", "3" as unknown],
    ["NaN", Number.NaN],
    ["fractional", 6.5],
  ])("ignores an ack with a %s utterance_id rather than poisoning the filter", (_label, uid) => {
    const { ws, cb } = openReadySession();
    ws.serverMessage(makePartial(5, "current"));
    // A reset ack, not a stop ack: stop tears the session down, which would
    // drop the follow-up message for reasons that have nothing to do with the
    // filter and hide the very poisoning this asserts.
    const bad = { ...makeAck("reset", 6) } as Record<string, unknown>;
    if (uid === undefined) delete bad.utterance_id;
    else bad.utterance_id = uid;
    ws.serverMessage(bad as unknown as WsStreamServerMessage);

    // The filter must still be intact: a stale message is still dropped.
    ws.serverMessage(makePartial(4, "stale"));
    expect(cb.onPartial).toHaveBeenCalledOnce();
    expect(cb.onPartial.mock.calls[0][0].text).toBe("current");
  });

  it("warns on seq regression but does not fail the session", () => {
    const { ws, cb } = openReadySession();
    ws.serverMessage({ ...makePartial(0, "a"), seq: 100 });
    ws.serverMessage({ ...makePartial(0, "b"), seq: 3 });
    expect(console.warn).toHaveBeenCalled();
    expect(cb.onPartial).toHaveBeenCalledTimes(2);
    expect(cb.onDegrade).not.toHaveBeenCalled();
  });
});

describe("error classification (C10.2 default rule)", () => {
  it.each(["busy", "preempted", "session_timeout", "model_swapping"] as const)(
    "fatal %s degrades",
    (code) => {
      const { ws, cb } = openReadySession();
      ws.serverMessage(makeError(code, true));
      expect(cb.onDegrade).toHaveBeenCalledWith({
        kind: "fatal_error",
        code,
        detail: "detail",
      });
      expect(cb.onSurfaceError).not.toHaveBeenCalled();
    }
  );

  it("fatal decode_failure surfaces and never degrades", () => {
    const { ws, cb } = openReadySession();
    ws.serverMessage(makeError("decode_failure", true, "GPU fell over"));
    expect(cb.onSurfaceError).toHaveBeenCalledWith("GPU fell over");
    expect(cb.onDegrade).not.toHaveBeenCalled();
  });

  it("non-fatal overrun keeps the session open", () => {
    const { session, ws, cb } = openReadySession();
    ws.serverMessage(makeError("overrun", false));
    expect(cb.onNonFatal).toHaveBeenCalledOnce();
    expect(session.state).toBe("open");
    expect(cb.onDegrade).not.toHaveBeenCalled();
  });

  it("unexpected close after ready degrades with the close code", () => {
    const { ws, cb } = openReadySession();
    ws.serverClose(4409);
    expect(cb.onDegrade).toHaveBeenCalledWith({ kind: "closed", closeCode: 4409 });
  });
});

describe("stop lifecycle (C3.5)", () => {
  it("drains pending audio, sends stop, fires onStopped on ack", () => {
    const { session, ws, cb } = openReadySession();
    session.sendAudio(samples(100));
    session.stop();
    expect(ws.sentFrames.at(-1)?.byteLength).toBe(400); // drained before stop
    expect(ws.sentControls.at(-1)).toEqual({ type: "stop" });
    ws.serverMessage(makeAck("stop", 1));
    expect(cb.onStopped).toHaveBeenCalledOnce();
    expect(session.state).toBe("closed");
  });

  it("sendAudio after stop is an explicit no-op (C2.4 client rule)", () => {
    const { session, ws } = openReadySession();
    session.stop();
    const framesAtStop = ws.sentFrames.length;
    session.sendAudio(samples(1536));
    expect(ws.sentFrames).toHaveLength(framesAtStop);
  });

  it("completes the stop when the final audio drain throws", async () => {
    const { session, ws, cb } = openReadySession();
    session.sendAudio(samples(100)); // sub-frame remainder: stop() must drain it
    // A socket that has closed under us: ws.send throws InvalidStateError. The
    // drain hits it before the stop control does, so a drain outside the guard
    // throws straight out of stop() — no state change, no deadline, and a
    // caller left waiting on an onStopped that can never arrive.
    ws.send = () => {
      throw new Error("InvalidStateError");
    };

    expect(() => session.stop()).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cb.onStopped).toHaveBeenCalledOnce();
    expect(session.state).toBe("closed");
  });

  it("server close racing the stop ack still fires onStopped once", () => {
    const { session, ws, cb } = openReadySession();
    session.stop();
    ws.serverClose(1000);
    expect(cb.onStopped).toHaveBeenCalledOnce();
    expect(cb.onDegrade).not.toHaveBeenCalled();
  });
});

describe("teardown", () => {
  it("close is idempotent and silences all callbacks", () => {
    const { session, ws, cb } = openReadySession();
    session.close();
    session.close();
    ws.serverMessage(makePartial(0, "late"));
    ws.serverMessage(makeFinal(0, "late"));
    ws.serverClose(1006);
    expect(cb.onPartial).not.toHaveBeenCalled();
    expect(cb.onFinal).not.toHaveBeenCalled();
    expect(cb.onDegrade).not.toHaveBeenCalled();
    expect(session.state).toBe("closed");
  });

  it("degrade fires at most once across error+close sequences", () => {
    const { ws, cb } = openReadySession();
    ws.serverMessage(makeError("busy", true));
    ws.serverClose(4409);
    expect(cb.onDegrade).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Robustness fixes from the 2026-08-09 review passes. These cover behavior that
// voice-scribe shipped without; the inverse migration carries them upstream.
// ---------------------------------------------------------------------------

describe("robustness", () => {
  it("degrades when the server accepts the socket but never sends ready", async () => {
    const cb = makeCallbacks();
    openStreamSession({}, cb);
    const sock = FakeWebSocket.instances[0];
    sock.serverOpen(); // socket opens, `start` goes out, no `ready` ever arrives
    expect(cb.onDegrade).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cb.onDegrade).toHaveBeenCalledWith({ kind: "connect_failed" });
  });

  it("degrades when the socket never leaves CONNECTING", async () => {
    const cb = makeCallbacks();
    openStreamSession({}, cb);
    // No serverOpen(): the connect stalls, so onopen never fires. Arming the
    // deadline in onopen would have left this case unguarded entirely.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cb.onDegrade).toHaveBeenCalledWith({ kind: "connect_failed" });
  });

  it("does not degrade on the ready timeout once ready has arrived", async () => {
    const cb = makeCallbacks();
    openReadySession(cb);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cb.onDegrade).not.toHaveBeenCalled();
  });

  it("copies queued samples so a reused capture buffer cannot mutate them", () => {
    const cb = makeCallbacks();
    const { session, ws } = openReadySession(cb);
    // A sub-frame remainder stays queued; vad-web reuses this buffer.
    const reused = new Float32Array([0.5, 0.5, 0.5]);
    session.sendAudio(reused);
    reused.fill(-1); // caller's buffer is recycled before the next drain
    session.sendAudio(samples(1536, 0.25));
    const sent = ws.sentSamples();
    expect(Array.from(sent.slice(0, 3))).toEqual([0.5, 0.5, 0.5]);
  });

  it("does not signal onStopped twice when stop() follows close()", () => {
    const cb = makeCallbacks();
    const session = openStreamSession({}, cb);
    session.close();
    session.stop();
    expect(cb.onStopped).not.toHaveBeenCalled();
  });

  it("signals onStopped when stop() is called before the session is ready", () => {
    const cb = makeCallbacks();
    const session = openStreamSession({}, cb);
    session.stop();
    expect(cb.onStopped).toHaveBeenCalled();
  });
});

describe("malformed input and stop deadline", () => {
  it("survives a JSON null payload and still handles the next valid message", () => {
    const cb = makeCallbacks();
    const { ws } = openReadySession(cb);
    // JSON.stringify(null) === "null": valid JSON, not a message object.
    ws.serverMessage(null as unknown as Parameters<typeof ws.serverMessage>[0]);
    ws.serverMessage(makePartial(0, "after junk"));
    expect(cb.onPartial).toHaveBeenCalledWith(
      expect.objectContaining({ text: "after junk" })
    );
  });

  it("completes the stop when the peer never acks", async () => {
    const cb = makeCallbacks();
    const { session } = openReadySession(cb);
    session.stop();
    expect(cb.onStopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cb.onStopped).toHaveBeenCalled();
  });
});
