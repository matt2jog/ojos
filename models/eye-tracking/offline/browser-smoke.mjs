import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { deviceKey, predict, encodePoint, quantile } from "../src/calibration.mjs";
import { extractFeatures } from "../src/features.mjs";
import { exportGaze } from "../src/timeline.mjs";

const [imagePath, rawPath, reportPath] = process.argv.slice(2);
if (!imagePath || !rawPath || !reportPath) {
  throw new Error("Usage: node offline/browser-smoke.mjs IMAGE NATIVE_OBSERVATION_JSON REPORT_JSON");
}
const image = await readFile(imagePath);
const raw = JSON.parse(await readFile(rawPath));
const native = extractFeatures(raw, ...raw.camera).features;
assert.ok(native, "Fixture requires one usable face in native MediaPipe");

const geometry = {
  cameraWidth: raw.camera[0], cameraHeight: raw.camera[1], cameraId: "smoke-camera",
  displayId: "smoke-display", displayScale: 1, viewportWidth: 1440, viewportHeight: 900,
  rotationDeg: 90,
};
const calibration = {
  version: 1, deviceKey: deviceKey(geometry), uncertaintyRadiusPx: 60,
  model: {
    means: native, scales: [1, 1, 1, 1, 1, 1, 1],
    outputs: [
      { intercept: 0.4, weights: [0.2, 0, 0.2, 0, 0, 0, 0] },
      { intercept: 0.6, weights: [0, 0.2, 0, 0.2, 0, 0, 0] },
    ],
  },
};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    return;
  }
  if (pathname === "/input.jpg") {
    response.writeHead(200, { "Content-Type": "image/jpeg" }).end(image);
    return;
  }
  if (!/^\/(gaze-worker\.js|face_landmarker\.task|wasm\/vision_wasm_[a-z_]+\.(js|wasm))$/.test(pathname)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(new URL("../dist" + pathname, import.meta.url));
    const type = pathname.endsWith(".wasm") ? "application/wasm" :
      pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type }).end(data);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const sessionId = "77510d91-432d-4c51-b2e6-59cb27986589";
try {
  browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  page.on("console", message => console.log("Browser " + message.type() + " " + message.text()));
  await page.goto("http://127.0.0.1:" + server.address().port);
  const trace = await page.evaluate(async ({ geometry, calibration, sessionId }) => {
    const worker = new Worker("/gaze-worker.js");
    let id = 0;
    function send(type, data = {}, transfer = []) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(new Error("Worker timed out on " + type)), 20_000);
        function listen({ data: result }) {
          if (result.requestId !== requestId) return;
          clearTimeout(timer);
          worker.removeEventListener("message", listen);
          if (result.type === "error") reject(new Error(result.message));
          else resolve(result);
        }
        worker.addEventListener("message", listen);
        worker.postMessage({ type, requestId, ...data }, transfer);
      });
    }

    await send("start", { options: {
      sessionId, captureEpoch: 1, geometry, calibration,
      assets: { wasmRoot: location.origin + "/wasm", modelUrl: location.origin + "/face_landmarker.task" },
    } });
    const bitmap = await createImageBitmap(await (await fetch("/input.jpg")).blob());
    const blank = new OffscreenCanvas(geometry.cameraWidth, geometry.cameraHeight);
    const blankContext = blank.getContext("2d");
    blankContext.fillStyle = "#000";
    blankContext.fillRect(0, 0, blank.width, blank.height);

    const outputs = [];
    const roundTripMs = [];
    for (let i = 0; i <= 120; i++) {
      const timeUs = Math.round(i * 1e6 / 30);
      const frame = new VideoFrame(i >= 58 && i <= 63 ? blank : bitmap, { timestamp: timeUs });
      const started = performance.now();
      const reply = await send("frame", { frame, timeUs }, [frame]);
      if (reply.output) {
        outputs.push(reply.output);
        if (i >= 10 && (i < 58 || i > 63)) roundTripMs.push(performance.now() - started);
      }
    }
    bitmap.close();
    const { stats } = await send("stats");
    await send("close");
    worker.terminate();
    return { outputs, stats, roundTripMs };
  }, { geometry, calibration, sessionId });

  const initial = trace.outputs[0];
  assert.equal(initial.message.valid, true);
  assert.equal(initial.message.uncertainty_radius_px, 60);
  const deviations = native.map((value, i) => Math.abs(value - initial.observation.features[i]));
  assert.ok(Math.max(...deviations) < 0.03, JSON.stringify({ native, web: initial.observation.features }));
  const expected = encodePoint(predict(calibration.model, initial.observation.features), geometry);
  assert.ok(Math.abs(initial.message.x_px - expected[0]) < 1e-6);
  assert.ok(Math.abs(initial.message.y_px - expected[1]) < 1e-6);
  assert.ok(trace.outputs.some(record => record.reason === "tracking_lost"));
  assert.equal(trace.outputs.at(-1).message.valid, true);
  assert.equal(trace.stats.inferred, 81);
  assert.equal(trace.stats.effectiveHz, 20);

  const history = trace.outputs.map(row => row.message);
  const clip = exportGaze(history, { sessionId, captureEpoch: 1,
    clipStartUs: 400_000, clipEndUs: 3_600_000 });
  assert.equal(clip.gaze_status, "available");
  assert.equal(clip.gaze.samples.length, 16);
  assert.equal(clip.gaze.samples.find(row => row.time_us === 1_600_000).valid, false);
  const report = {
    chromium: browser.version(), camera: raw.camera, testing: "sequential worker, CPU inference, SwiftShader",
    featureParityAbsoluteDeviation: deviations, medianWorkerRoundTripMs: quantile(trace.roundTripMs, 0.5),
    p95WorkerRoundTripMs: quantile(trace.roundTripMs, 0.95), stats: trace.stats,
    traceExcerpt: trace.outputs.filter(row => row.message.time_us >= 1_900_000 &&
      row.message.time_us <= 2_200_000).map(({ message, reason }) => ({ message, reason })),
    clip,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, clip: undefined, traceExcerpt: undefined }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
