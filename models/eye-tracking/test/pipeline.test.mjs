import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CalibrationSession, FIT_TARGETS, VALIDATION_TARGETS, clearCalibration, deviceKey, encodePoint,
  fitRidge, loadCalibration, predict, saveCalibration,
} from "../src/calibration.mjs";
import { extractFeatures } from "../src/features.mjs";
import { LatestGazeFrames } from "../src/frame-queue.mjs";
import { exportGaze, GazeMedianFilter, invalidPoint, validPoint } from "../src/timeline.mjs";

const geometry = {
  cameraId: "cam", cameraWidth: 1280, cameraHeight: 720, displayId: "display", displayScale: 1,
  viewportWidth: 1920, viewportHeight: 1080, rotationDeg: 0,
};

function fixture([x, y]) {
  return [x, y, x, y, 0, 0, 0];
}

function capture(skip) {
  const session = new CalibrationSession(geometry);
  let timeUs = 0;
  for (const target of [...FIT_TARGETS, ...VALIDATION_TARGETS]) {
    assert.equal(session.nextTarget.id, target.id);
    const window = session.showTarget(timeUs);
    assert.throws(() => session.finishTarget(window.collectUntilUs - 1));
    session.observe(window.collectFromUs - 1, { features: fixture([1, 1]) });
    if (target.id !== skip) session.observe(window.collectFromUs, { features: fixture(target.point) });
    session.observe(window.collectFromUs + 50_000, { reason: "blink" });
    session.observe(window.collectUntilUs, { features: fixture([1, 1]) });
    session.finishTarget(window.collectUntilUs);
    timeUs = window.collectUntilUs;
  }
  return session.fit();
}

test("nine time-filtered targets fit, five held-out targets gate, and keys reject changed geometry", () => {
  const { calibration, metrics } = capture();
  assert.equal(metrics.usable, 5);
  assert.equal(metrics.frames, 28);
  assert.equal(metrics.coverage, 0.5);
  assert.equal(metrics.effectiveHz, 4);
  assert.ok(calibration.uncertaintyRadiusPx > 0);
  assert.ok(metrics.medianErrorPx < metrics.thresholdPx);
  assert.ok(predict(calibration.model, fixture([0.8, 0.4]))[0] > 0.75);

  const backing = new Map();
  const storage = {
    getItem: key => backing.get(key), setItem: (key, value) => backing.set(key, value),
    removeItem: key => backing.delete(key),
  };
  saveCalibration(storage, geometry, calibration);
  assert.deepEqual(loadCalibration(storage, geometry), calibration);
  for (const [field, value] of Object.entries({
    cameraId: "other", cameraWidth: 640, cameraHeight: 480, displayId: "other",
    displayScale: 2, rotationDeg: 90, viewportWidth: 640, viewportHeight: 480,
  })) {
    assert.notEqual(deviceKey({ ...geometry, [field]: value }), deviceKey(geometry));
    assert.equal(loadCalibration(storage, { ...geometry, [field]: value }), null);
  }
  clearCalibration(storage, geometry);
  assert.equal(loadCalibration(storage, geometry), null);
  assert.deepEqual(encodePoint([0, 0], { ...geometry, rotationDeg: 90 }), [1919, 0]);
  assert.deepEqual(encodePoint([0, 0], { ...geometry, rotationDeg: 180 }), [1919, 1079]);
  assert.deepEqual(encodePoint([0, 0], { ...geometry, rotationDeg: 270 }), [0, 1079]);
  assert.equal(capture("fit-1").reason, "missing_fit_target");
  assert.equal(capture("validation-1").reason, "validation_failed");
});

test("ridge matches an independent analytic solution in a collinear case", () => {
  const rows = [0.1, 0.3, 0.5, 0.7, 0.9].map(x => ({
    features: fixture([x, x]), target: [x, 1 - x],
  }));
  const alpha = 0.05;
  const model = fitRidge(rows, alpha);
  const result = predict(model, fixture([0.8, 0.8]));
  const expected = 0.5 + 0.3 * 4 / (4 + alpha);
  assert.ok(Math.abs(result[0] - expected) < 1e-12);
  assert.ok(Math.abs(result[1] - (1 - expected)) < 1e-12);
});

test("scaled column-major pose, iris projection, blink and tracking rejection", () => {
  const angle = 0.2;
  const c = Math.cos(angle) * 2;
  const s = Math.sin(angle) * 2;
  const matrix = [c, 0, -s, 0, 0, 2, 0, 0, s, 0, c, 0, 0, 0, -30, 1];
  const landmarks = {
    33: [0.2, 0.5], 133: [0.3, 0.5], 159: [0.25, 0.48], 145: [0.25, 0.52], 468: [0.25, 0.5],
    362: [0.6, 0.5], 263: [0.7, 0.5], 386: [0.65, 0.48], 374: [0.65, 0.52], 473: [0.65, 0.5],
  };
  const raw = { faces: 1, landmarks, matrix };
  const result = extractFeatures(raw, 1280, 720).features;
  assert.ok(Math.abs(result[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(result[4] - angle) < 1e-12);
  assert.equal(extractFeatures({ faces: 0 }, 1280, 720).reason, "tracking_lost");
  assert.equal(extractFeatures({ faces: 2 }, 1280, 720).reason, "ambiguous_face");
  landmarks[145] = [0.25, 0.49];
  assert.equal(extractFeatures(raw, 1280, 720).reason, "blink");
});

test("filter resets on invalid observations and long gaps", () => {
  const filter = new GazeMedianFilter();
  for (const [time, x] of [[0, 10], [50_000, 30], [100_000, 20]]) {
    assert.equal(filter.push(validPoint(time, [x, x], 4)).x_px, x);
  }
  assert.equal(filter.push(validPoint(150_000, [90, 90], 4)).x_px, 30);
  filter.push(invalidPoint(200_000));
  assert.equal(filter.push(validPoint(250_000, [99, 99], 4)).x_px, 99);
  assert.equal(filter.push(validPoint(350_000, [10, 10], 4)).x_px, 10);
});

test("export uses actual clip zero, drops blink gaps, rejects 100ms interpolation and scopes epoch", () => {
  const { history, clip: opts, expected } = JSON.parse(
    readFileSync(new URL("gaze-replay.json", import.meta.url), "utf8"),
  );
  const result = exportGaze(history, opts);
  assert.deepEqual(result, expected);
  assert.equal(result.gaze_status, "available");
  assert.deepEqual(result.gaze.samples, [
    validPoint(0, [20, 20], 4), invalidPoint(200_000), invalidPoint(400_000),
    invalidPoint(600_000), validPoint(800_000, [80, 80], 4),
  ]);
  assert.deepEqual(exportGaze(history, { ...opts, captureEpoch: 3 }), {
    gaze_status: "unavailable", gaze: { schema_version: 1, samples: [] },
  });
});

test("backpressure retains the latest waiting frame and disposes dropped frames", async () => {
  const waits = [];
  const seen = [];
  const closed = [];
  const queue = new LatestGazeFrames((frame, time) => {
    seen.push(time);
    frame.close();
    return new Promise(resolve => waits.push(resolve));
  }, assert.fail);
  for (const time of [1, 2, 3]) queue.submit({ close: () => closed.push(time) }, time);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(closed, [1, 2]);
  assert.equal(queue.droppedFrames, 1);
  waits[0]();
  await Promise.resolve();
  assert.deepEqual(seen, [1, 3]);
  queue.close();
  waits[1]();
  assert.deepEqual(closed, [1, 2, 3]);
});
