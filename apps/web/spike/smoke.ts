/**
 * v4.1 live streaming smoke driver (dev-only, spike dir — not in the build).
 *
 * Loads the real App in a same-origin iframe, forces continuous mode, clicks
 * Record, and observes the streaming UI while the fake-device microphone
 * (--use-file-for-fake-audio-capture) plays real dictation. Collected output:
 * DOM observations + final transcript, POSTed to a local receiver for
 * comparison against the rehearsed script — never committed.
 */
const params = new URLSearchParams(location.search);
const RUN_SECONDS = Number(params.get("runs") || "90");
const statusEl = document.getElementById("status")!;
const outEl = document.getElementById("out")!;
const iframe = document.getElementById("app") as HTMLIFrameElement;

const log = (s: string) => {
  statusEl.textContent = s;
  console.log(`[smoke] ${s}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function q<T extends Element>(sel: string): T | null {
  return iframe.contentDocument?.querySelector<T>(sel) ?? null;
}

function findButton(label: string): HTMLButtonElement | null {
  const doc = iframe.contentDocument;
  if (!doc) return null;
  return (
    Array.from(doc.querySelectorAll("button")).find((b) =>
      b.textContent?.trim().startsWith(label)
    ) ?? null
  );
}

async function run() {
  log("loading app in iframe (continuous mode)…");
  // Same-origin iframe shares localStorage — set mode before the App mounts.
  localStorage.setItem("voice-scribe-recording-mode", "continuous");
  localStorage.setItem("voice-scribe-audio-muted", "true");
  iframe.src = "/";
  await new Promise((r) => (iframe.onload = r));

  // Wait for the Record button (backend-ready gate is browser-instant).
  let recordBtn: HTMLButtonElement | null = null;
  for (let i = 0; i < 50 && !recordBtn; i++) {
    await sleep(200);
    recordBtn = findButton("Record");
  }
  if (!recordBtn) {
    finish({ ok: false, error: "Record button never appeared" });
    return;
  }
  log("clicking Record — streaming session should open…");
  recordBtn.click();

  const observations = {
    liveRegionSeenAt: [] as number[],
    tentativeSeenAt: [] as number[],
    buttonBecameStop: false,
    errorBanner: null as string | null,
    samples: 0,
  };
  const t0 = Date.now();
  while (Date.now() - t0 < RUN_SECONDS * 1000) {
    await sleep(500);
    observations.samples++;
    const secs = Math.round((Date.now() - t0) / 1000);
    if (findButton("Stop")) observations.buttonBecameStop = true;
    if (q(".transcript-live")) observations.liveRegionSeenAt.push(secs);
    if (q(".transcript-live .tentative")) observations.tentativeSeenAt.push(secs);
    const err = q<HTMLParagraphElement>(".error");
    if (err && !observations.errorBanner) observations.errorBanner = err.textContent;
    if (observations.samples % 20 === 0) log(`observing… ${secs}s`);
  }

  log("clicking Stop — expecting drain to done…");
  findButton("Stop")?.click();
  await sleep(4000); // implicit flush + final + ack

  const textarea = q<HTMLTextAreaElement>(".transcript textarea");
  const transcript = textarea?.value ?? "";
  finish({
    ok: true,
    ranSeconds: RUN_SECONDS,
    buttonBecameStop: observations.buttonBecameStop,
    liveRegionSampleCount: observations.liveRegionSeenAt.length,
    liveRegionFirstSeenS: observations.liveRegionSeenAt[0] ?? null,
    tentativeTailSampleCount: observations.tentativeSeenAt.length,
    liveRegionClearedAtEnd: q(".transcript-live") === null,
    errorBanner: observations.errorBanner,
    transcriptWordCount: transcript ? transcript.split(/\s+/).length : 0,
    transcriptParagraphs: transcript ? transcript.split("\n\n").length : 0,
    transcript, // local receiver only — never committed
  });
}

async function finish(result: Record<string, unknown>) {
  const { transcript, ...display } = result;
  outEl.textContent = JSON.stringify(display, null, 2);
  log(result.ok ? "SMOKE COMPLETE" : "SMOKE FAILED");
  const post = params.get("post");
  if (post) {
    try {
      await fetch(post, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
    } catch (e) {
      log(`POST failed: ${e}`);
    }
  }
}

if (params.get("auto") === "1") run();
else {
  const btn = document.createElement("button");
  btn.textContent = "Run smoke";
  btn.onclick = run;
  document.body.insertBefore(btn, iframe);
}
