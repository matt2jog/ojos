const edge = new Worker("/dist/bench-worker.js");
let nextRequest = 0;
const requests = new Map();
edge.onmessage = ({ data }) => {
  const { resolve, reject } = requests.get(data.id);
  requests.delete(data.id);
  if (data.error) reject(new Error(data.error));
  else resolve(data.result);
};
edge.onerror = error => {
  for (const { reject } of requests.values()) reject(new Error(error.message));
  requests.clear();
};
function send(data, transfer = []) {
  const id = ++nextRequest;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    edge.postMessage({ id, ...data }, transfer);
  });
}

async function* decode(meta, bytes, start, stop) {
  const frames = [];
  let wake;
  let failure;
  let done = false;
  const notify = () => wake?.();
  const decoder = new VideoDecoder({
    output(frame) { frames.push(frame); notify(); },
    error(error) { failure = error; notify(); },
  });
  decoder.configure({ codec: meta.codec, codedWidth: meta.camera[0], codedHeight: meta.camera[1],
    hardwareAcceleration: "prefer-software" });
  decoder.ondequeue = notify;
  let index = meta.frames.findIndex(row => row[0] >= start);
  if (index < 0) throw new Error("Window begins after recording");
  while (index > 0 && !meta.frames[index][3]) index--;
  let flushing = false;

  try {
    while (!done || frames.length) {
      if (failure) throw failure;
      while (decoder.decodeQueueSize + frames.length < 10 && !flushing) {
        const row = meta.frames[index++];
        if (!row || row[0] >= stop) {
          flushing = true;
          decoder.flush().then(() => { done = true; notify(); }, error => { failure = error; notify(); });
        } else {
          const [timestamp, byteStart, size, key] = row;
          decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp,
            data: bytes.subarray(byteStart, byteStart + size) }));
        }
      }

      if (frames.length) {
        const frame = frames.shift();
        if (frame.timestamp >= start && frame.timestamp < stop) yield frame;
        else frame.close();
      } else if (!done) {
        await new Promise(resolve => { wake = resolve; });
      }
    }
  } finally {
    decoder.close();
    for (const frame of frames) frame.close();
  }
}

const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

window.run = async ({ name, variant, backend, tfThreads, landmarkDelegate, matrixLayout, height, rate, windowName, fromUs, duration,
  paced, profile, displayLoad, adapt }) => {
  const meta = await (await fetch("/media/" + name + "/index.json")).json();
  const bytes = new Uint8Array(await (await fetch("/media/" + name + "/packets.bin")).arrayBuffer());
  const width = Math.round(height * meta.camera[0] / meta.camera[1]);
  const geometry = { viewportWidth: meta.viewport[0], viewportHeight: meta.viewport[1], rotationDeg: 0 };
  const runtime = await send({ config: { variant, backend, tfThreads, landmarkDelegate, matrixLayout, dimensions: [width, height],
    geometry, profile, fitTargets: adapt ? meta.targets.filter(target => target.kind === "fit") : undefined } });
  let [start, end] = meta.windows[windowName];
  if (fromUs !== null) start = fromUs;
  if (duration !== null) end = Math.min(end, start + duration * 1e6);
  if (end <= start) throw new Error("Empty test window");

  const rows = [];
  let offered = 0;
  let decoded = 0;
  let dropped = 0;
  let pending = null;
  let processing = null;
  let base;
  let nextDue;
  const period = 1e6 / rate;
  let fail;
  let loadCount = 0;
  let encoder;
  let loadTimer;
  if (displayLoad) {
    const canvas = new OffscreenCanvas(1920, 1200);
    const context = canvas.getContext("2d");
    encoder = new VideoEncoder({ output() { loadCount++; }, error(error) { fail = error; } });
    encoder.configure({ codec: "vp8", width: 1920, height: 1200, framerate: 20,
      bitrate: 3_000_000, hardwareAcceleration: "prefer-software", latencyMode: "realtime" });
    loadTimer = setInterval(() => {
      if (encoder.encodeQueueSize > 2) return;
      const index = loadCount % 255;
      context.fillStyle = "rgb(" + index + ",80,120)";
      context.fillRect(0, 0, 1920, 1200);
      for (let row = 0; row < 40; row++) {
        context.fillStyle = row % 2 ? "#f8f8f8" : "#101010";
        context.fillRect((row * 101 + index * 7) % 1500, row * 29, 340, 8);
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
      encoder.encode(frame);
      frame.close();
    }, 50);
  }

  function kick() {
    if (processing || !pending || fail) return;
    const job = pending;
    pending = null;
    const dispatch = performance.timeOrigin + performance.now();
    processing = send({ frame: job.frame }, [job.frame]).then(result => {
      const finished = performance.timeOrigin + performance.now();
      rows.push({ ...result, queueMs: dispatch - job.arrived, deliveryMs: finished - job.arrived,
        ageMs: finished - job.captured, inputDelayMs: job.arrived - job.captured,
        dispatchToWorkerMs: result.started - dispatch, resultDeliveryMs: finished - result.ended });
    }).catch(error => { fail = error; }).finally(() => { processing = null; kick(); });
  }

  const wallStart = performance.now();
  try {
    for await (const frame of decode(meta, bytes, start, end)) {
      if (fail) { frame.close(); throw fail; }
      decoded++;
      const now = performance.timeOrigin + performance.now();
      base ??= now - (frame.timestamp - start) / 1000;
      const dueAt = base + (frame.timestamp - start) / 1000;
      if (paced && dueAt - now > 1) await wait(dueAt - now);
      nextDue ??= frame.timestamp;
      if (frame.timestamp + 1e-5 < nextDue) { frame.close(); continue; }
      nextDue += (Math.floor((frame.timestamp - nextDue + 1e-5) / period) + 1) * period;
      offered++;
      if (pending) { pending.frame.close(); dropped++; }
      const arrived = performance.timeOrigin + performance.now();
      pending = { frame, arrived, captured: paced ? dueAt : arrived };
      kick();
      if (!paced) await processing;
    }
    while (processing) await processing;
    if (fail) throw fail;
  } finally {
    pending?.frame.close();
    clearInterval(loadTimer);
    if (encoder && encoder.state === "configured") { await encoder.flush(); encoder.close(); }
    edge.terminate();
  }
  return { rows, runtime, meta: { targets: meta.targets, windows: meta.windows, viewport: meta.viewport },
    dimensions: [width, height], start, end, decoded, offered, dropped,
    wallMs: performance.now() - wallStart, displayEncoded: loadCount };
};
