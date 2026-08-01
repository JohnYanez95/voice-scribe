/**
 * v4.1 de-risk spike: does vad-web 0.0.30's onFrameProcessed deliver contiguous,
 * undecimated 16 kHz frames? (roadmap v4 section — promoted first task of v4.1)
 *
 * Not part of the app build. Auto mode (?auto=1[&post=URL]) runs the synthetic suite
 * and POSTs compact metrics for headless runs. Persisted output is metrics only.
 */
import { MicVAD } from "@ricky0123/vad-web";

const SR = 16000;
const CHIRP_F0 = 100;
const CHIRP_F1 = 7500;
const CHIRP_S = 8.0;
const LEAD_SILENCE_S = 0.5;
const BURST_COUNT = 5;
const BURST_ON_S = 0.2;
const BURST_OFF_S = 0.2;
const TAIL_S = 0.5;
const TOTAL_S =
  LEAD_SILENCE_S + CHIRP_S + 0.5 + BURST_COUNT * (BURST_ON_S + BURST_OFF_S) + TAIL_S;

const statusEl = document.getElementById("status")!;
const outEl = document.getElementById("out")!;
const log = (s: string) => {
  statusEl.textContent = s;
  console.log(`[spike] ${s}`);
};

/** Deterministic test signal, generated at an arbitrary rate. */
function synthSignal(rate: number): Float32Array {
  const n = Math.round(TOTAL_S * rate);
  const x = new Float32Array(n);
  const chirpStart = LEAD_SILENCE_S;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    if (t >= chirpStart && t < chirpStart + CHIRP_S) {
      const tc = t - chirpStart;
      const phase =
        2 * Math.PI * (CHIRP_F0 * tc + ((CHIRP_F1 - CHIRP_F0) * tc * tc) / (2 * CHIRP_S));
      x[i] = 0.5 * Math.sin(phase);
    } else {
      const burstsStart = chirpStart + CHIRP_S + 0.5;
      const tb = t - burstsStart;
      if (tb >= 0 && tb < BURST_COUNT * (BURST_ON_S + BURST_OFF_S)) {
        const within = tb % (BURST_ON_S + BURST_OFF_S);
        if (within < BURST_ON_S) x[i] = 0.4 * Math.sin(2 * Math.PI * 1000 * t);
      }
    }
  }
  return x;
}

interface FrameRecord {
  frame: Float32Array;
  at: number; // performance.now() at callback
  isSpeech: number;
}

interface RunResult {
  label: string;
  model: "legacy" | "v5";
  requestedRate: number | null;
  ctxRate: number;
  adapter: string | null;
  frameSamples: number;
  frames: number;
  totalSamples: number;
  elapsedMs: number;
  sampleRatioErr: number; // (received samples) / (elapsed * 16k) - 1
  nonFinite: number;
  chirpOffsetSamples: number | null;
  minWindowCorr: number | null;
  maxAbsDriftSamples: number | null; // per-window best-offset drift across the chirp
  rolloffDb: { hz: number; db: number }[];
  burstSpacingErrMs: number | null;
  cadence: { meanMs: number; p95Ms: number; maxGapMs: number; netDriftMs: number };
  pass: boolean;
  failReasons: string[];
}

function percentile(v: number[], p: number): number {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function normCorr(a: Float32Array, aOff: number, b: Float32Array, bOff: number, len: number) {
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < len; i++) {
    const va = a[aOff + i] ?? 0;
    const vb = b[bOff + i] ?? 0;
    sab += va * vb;
    saa += va * va;
    sbb += vb * vb;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

function rms(a: Float32Array, off: number, len: number) {
  let s = 0;
  for (let i = 0; i < len; i++) s += (a[off + i] ?? 0) ** 2;
  return Math.sqrt(s / len);
}

/** Analyze reconstructed 16 kHz stream against the analytic reference. */
function analyze(recon: Float32Array, res: RunResult) {
  const ref = synthSignal(SR);
  const chirpRefStart = Math.round(LEAD_SILENCE_S * SR);

  // Coarse chirp onset in the reconstruction: first sustained-energy sample.
  let onset = -1;
  for (let i = 0; i < recon.length - 160; i += 80) {
    if (rms(recon, i, 160) > 0.05) {
      onset = i;
      break;
    }
  }
  if (onset < 0) {
    res.failReasons.push("chirp not found in reconstruction");
    return;
  }
  // Refine with a template of the first 4000 chirp samples, ±1600 around the coarse onset.
  const tpl = 4000;
  let bestOff = -1;
  let bestCorr = -2;
  for (let off = Math.max(0, onset - 1600); off < onset + 1600; off++) {
    const c = normCorr(recon, off, ref, chirpRefStart, tpl);
    if (c > bestCorr) {
      bestCorr = c;
      bestOff = off;
    }
  }
  res.chirpOffsetSamples = bestOff;

  // Windowed correlation across the chirp with a local ±150-sample offset search:
  // detects mid-stream drops (corr collapse) and measures resampler drift (offset curve).
  const win = 2000;
  const searches = 150;
  let minCorr = 2;
  let maxDrift = 0;
  const rolloff: { hz: number; db: number }[] = [];
  for (let ws = 0; ws + win < CHIRP_S * SR; ws += SR / 2) {
    let wBest = -2;
    let wBestD = 0;
    for (let d = -searches; d <= searches; d++) {
      const c = normCorr(recon, bestOff + ws + d, ref, chirpRefStart + ws, win);
      if (c > wBest) {
        wBest = c;
        wBestD = d;
      }
    }
    minCorr = Math.min(minCorr, wBest);
    maxDrift = Math.max(maxDrift, Math.abs(wBestD));
    const t = ws / SR + win / SR / 2;
    const hz = Math.round(CHIRP_F0 + ((CHIRP_F1 - CHIRP_F0) * t) / CHIRP_S);
    const r = rms(recon, bestOff + ws + wBestD, win) / rms(ref, chirpRefStart + ws, win);
    rolloff.push({ hz, db: Math.round(20 * Math.log10(Math.max(r, 1e-6)) * 10) / 10 });
  }
  res.minWindowCorr = Math.round(minCorr * 1000) / 1000;
  res.maxAbsDriftSamples = maxDrift;
  res.rolloffDb = rolloff;

  // Tone bursts: onsets must be spaced exactly BURST_ON+BURST_OFF apart (time integrity).
  const burstsRefStart = Math.round((LEAD_SILENCE_S + CHIRP_S + 0.5) * SR);
  const scanFrom = bestOff + burstsRefStart - chirpRefStart - Math.round(0.25 * SR);
  const onsets: number[] = [];
  let inBurst = false;
  for (let i = Math.max(0, scanFrom); i < recon.length - 80; i += 16) {
    const e = rms(recon, i, 80);
    if (!inBurst && e > 0.1) {
      onsets.push(i);
      inBurst = true;
    } else if (inBurst && e < 0.02) {
      inBurst = false;
    }
  }
  if (onsets.length >= BURST_COUNT) {
    const expected = (BURST_ON_S + BURST_OFF_S) * SR;
    let worst = 0;
    for (let i = 1; i < BURST_COUNT; i++) {
      worst = Math.max(worst, Math.abs(onsets[i] - onsets[i - 1] - expected));
    }
    res.burstSpacingErrMs = Math.round((worst / SR) * 1000 * 10) / 10;
  } else {
    res.failReasons.push(`expected ${BURST_COUNT} tone bursts, found ${onsets.length}`);
  }
}

async function runOne(
  label: string,
  model: "legacy" | "v5",
  requestedRate: number | null
): Promise<RunResult> {
  const res: RunResult = {
    label,
    model,
    requestedRate,
    ctxRate: 0,
    adapter: null,
    frameSamples: 0,
    frames: 0,
    totalSamples: 0,
    elapsedMs: 0,
    sampleRatioErr: NaN,
    nonFinite: 0,
    chirpOffsetSamples: null,
    minWindowCorr: null,
    maxAbsDriftSamples: null,
    rolloffDb: [],
    burstSpacingErrMs: null,
    cadence: { meanMs: NaN, p95Ms: NaN, maxGapMs: NaN, netDriftMs: NaN },
    pass: false,
    failReasons: [],
  };

  const ctx = requestedRate
    ? new AudioContext({ sampleRate: requestedRate })
    : new AudioContext();
  await ctx.resume();
  res.ctxRate = ctx.sampleRate;

  const signal = synthSignal(ctx.sampleRate);
  const buf = ctx.createBuffer(1, signal.length, ctx.sampleRate);
  buf.copyToChannel(signal, 0);
  const dest = ctx.createMediaStreamDestination();

  const records: FrameRecord[] = [];
  // startOnLoad (default true) invokes getStream inside MicVAD.new — the stream must
  // exist now, and pause/resume must not touch it (defaults stop the track / grab the mic).
  const vad = await MicVAD.new({
    model,
    audioContext: ctx,
    getStream: async () => dest.stream,
    pauseStream: async () => {},
    resumeStream: async () => dest.stream,
    baseAssetPath: "/",
    onnxWASMBasePath: "/node_modules/onnxruntime-web/dist/",
    onFrameProcessed: (probs, frame) => {
      records.push({ frame, at: performance.now(), isSpeech: probs.isSpeech });
    },
  });
  res.adapter = (vad as unknown as { _audioProcessorAdapterType: string | null })
    ._audioProcessorAdapterType;
  await vad.start();

  const t0 = performance.now();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(dest);
  const ended = new Promise<void>((r) => (src.onended = () => r()));
  src.start();
  await ended;
  // Let the resampler/worklet pipeline drain.
  await new Promise((r) => setTimeout(r, 500));
  const t1 = performance.now();
  await vad.destroy();
  await ctx.close();

  res.elapsedMs = Math.round(t1 - t0);
  res.frames = records.length;
  res.frameSamples = records[0]?.frame.length ?? 0;
  const sizes = new Set(records.map((r) => r.frame.length));
  if (sizes.size > 1) res.failReasons.push(`inconsistent frame sizes: ${[...sizes]}`);

  const recon = new Float32Array(res.frameSamples * records.length);
  let nonFinite = 0;
  records.forEach((r, i) => {
    for (let j = 0; j < r.frame.length; j++) {
      const v = r.frame[j];
      if (!Number.isFinite(v)) {
        nonFinite++;
        recon[i * res.frameSamples + j] = 0;
      } else {
        recon[i * res.frameSamples + j] = v;
      }
    }
  });
  res.nonFinite = nonFinite;
  res.totalSamples = recon.length;
  // Frames flow from vad.start() (destination emits silence before/after the source);
  // undecimated ⇔ received samples ≈ elapsed wall clock × 16 kHz.
  res.sampleRatioErr =
    Math.round((res.totalSamples / ((res.elapsedMs / 1000) * SR) - 1) * 1e4) / 1e4;

  const gaps = records.slice(1).map((r, i) => r.at - records[i].at);
  const expectedMs = (res.frameSamples / SR) * 1000;
  res.cadence = {
    meanMs: Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10,
    p95Ms: Math.round(percentile(gaps, 0.95) * 10) / 10,
    maxGapMs: Math.round(Math.max(...gaps) * 10) / 10,
    netDriftMs:
      Math.round((records[records.length - 1].at - records[0].at - gaps.length * expectedMs) * 10) /
      10,
  };

  analyze(recon, res);

  if (Math.abs(res.sampleRatioErr) > 0.01)
    res.failReasons.push(`sample ratio err ${res.sampleRatioErr} exceeds ±1%`);
  if (res.minWindowCorr !== null && res.minWindowCorr < 0.9)
    res.failReasons.push(`min windowed correlation ${res.minWindowCorr} < 0.90`);
  if (res.nonFinite > 0) res.failReasons.push(`${res.nonFinite} non-finite samples`);
  if (res.burstSpacingErrMs !== null && res.burstSpacingErrMs > 10)
    res.failReasons.push(`burst spacing error ${res.burstSpacingErrMs}ms > 10ms`);
  res.pass = res.failReasons.length === 0;
  return res;
}

async function runSyntheticSuite() {
  const results: RunResult[] = [];
  const matrix: [string, "legacy" | "v5", number | null][] = [
    ["legacy@default", "legacy", null],
    ["v5@default", "v5", null],
    ["legacy@44100", "legacy", 44100],
  ];
  for (const [label, model, rate] of matrix) {
    log(`running ${label}…`);
    try {
      results.push(await runOne(label, model, rate));
    } catch (e) {
      results.push({
        label,
        model,
        requestedRate: rate,
        failReasons: [`threw: ${String(e)}`],
        pass: false,
      } as RunResult);
    }
  }
  const report = {
    spike: "vad-web-onFrameProcessed",
    version: "0.0.30",
    ua: navigator.userAgent,
    when: new Date().toISOString(),
    pass: results.every((r) => r.pass),
    results,
  };
  outEl.textContent = JSON.stringify(report, null, 2);
  log(report.pass ? "SYNTHETIC SUITE: PASS" : "SYNTHETIC SUITE: FAIL");
  statusEl.className = report.pass ? "pass" : "fail";

  const post = new URLSearchParams(location.search).get("post");
  if (post) {
    try {
      await fetch(post, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      });
      log(`${report.pass ? "PASS" : "FAIL"} — report posted`);
    } catch (e) {
      log(`report POST failed: ${e}`);
    }
  }
  return report;
}

/** Mic sanity: 10 s of real capture, metrics only — no audio retained or posted. */
async function runMicSanity() {
  log("mic sanity: requesting mic…");
  let frames = 0;
  let nonFinite = 0;
  const at: number[] = [];
  const vad = await MicVAD.new({
    baseAssetPath: "/",
    onnxWASMBasePath: "/node_modules/onnxruntime-web/dist/",
    onFrameProcessed: (_p, frame) => {
      frames++;
      at.push(performance.now());
      for (let i = 0; i < frame.length; i++) if (!Number.isFinite(frame[i])) nonFinite++;
    },
  });
  const adapter = (vad as unknown as { _audioProcessorAdapterType: string | null })
    ._audioProcessorAdapterType;
  await vad.start();
  await new Promise((r) => setTimeout(r, 10_000));
  await vad.destroy();
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  const summary = {
    mode: "mic-sanity",
    adapter,
    frames,
    nonFinite,
    expectedFrames: Math.round((10_000 / 1000) * (SR / 1536)),
    meanGapMs: Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10,
    p95GapMs: Math.round(percentile(gaps, 0.95) * 10) / 10,
  };
  outEl.textContent = JSON.stringify(summary, null, 2);
  log("mic sanity done (metrics only)");
}

/**
 * VAD detection lag over a local speech file (e.g. data/tests/test.wav — stays local):
 * per utterance, (first frame with isSpeech ≥ 0.3) − (first frame with RMS onset).
 */
async function runFileLag(file: File) {
  log(`decoding ${file.name}…`);
  const ctx = new AudioContext();
  await ctx.resume();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  const dest = ctx.createMediaStreamDestination();
  const records: { rms: number; isSpeech: number }[] = [];
  const vad = await MicVAD.new({
    audioContext: ctx,
    getStream: async () => dest.stream,
    pauseStream: async () => {},
    resumeStream: async () => dest.stream,
    baseAssetPath: "/",
    onnxWASMBasePath: "/node_modules/onnxruntime-web/dist/",
    onFrameProcessed: (probs, frame) => {
      records.push({ rms: rms(frame, 0, frame.length), isSpeech: probs.isSpeech });
    },
  });
  await vad.start();
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(dest);
  const ended = new Promise<void>((r) => (src.onended = () => r()));
  src.start();
  log(`playing ${Math.round(decoded.duration)}s through VAD (real time)…`);
  await ended;
  await new Promise((r) => setTimeout(r, 500));
  await vad.destroy();
  await ctx.close();

  // Utterance = RMS rising above noise floor after ≥500ms below it.
  const frameMs = 96;
  const floor = 2 * percentile(records.map((r) => r.rms), 0.2);
  const lags: number[] = [];
  let quiet = Math.round(500 / frameMs);
  for (let i = 0; i < records.length; i++) {
    if (records[i].rms > Math.max(floor, 0.01)) {
      if (quiet >= Math.round(500 / frameMs)) {
        for (let j = i; j < Math.min(i + 40, records.length); j++) {
          if (records[j].isSpeech >= 0.3) {
            lags.push((j - i) * frameMs);
            break;
          }
        }
      }
      quiet = 0;
    } else {
      quiet++;
    }
  }
  const summary = {
    mode: "vad-detection-lag",
    file: file.name,
    utterancesDetected: lags.length,
    lagMs: { p50: percentile(lags, 0.5), p95: percentile(lags, 0.95), max: Math.max(...lags) },
    note: "lag = RMS onset → isSpeech≥0.3, 96ms frame granularity; metrics only",
  };
  outEl.textContent = JSON.stringify(summary, null, 2);
  log("file lag run done (metrics only)");
}

document.getElementById("run-synthetic")!.addEventListener("click", runSyntheticSuite);
document.getElementById("run-mic")!.addEventListener("click", runMicSanity);
document.getElementById("file-input")!.addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) runFileLag(f);
});

if (new URLSearchParams(location.search).get("auto") === "1") {
  runSyntheticSuite();
}
