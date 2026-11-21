import test from "node:test";
import assert from "node:assert/strict";
import { createAdapter, gazeFeatures } from "./adapter.mjs";
import { exportGaze } from "../../src/timeline.mjs";

test("experimental adapter uses existing epoch, rotation, invalid fields and 5 Hz export", () => {
  const geometry = { viewportWidth: 1920, viewportHeight: 1200, rotationDeg: 90 };
  const run = createAdapter("test", 2, geometry, { uncertaintyRadiusPx: 20 });
  const history = [
    run(0, gazeFeatures([0.25, 0.5])),
    run(180000, gazeFeatures([0.25, 0.5])),
    run(200000, null),
    run(220000, gazeFeatures([0.25, 0.5])),
    run(400000, gazeFeatures([1.25, 0.5])),
    run(600000, gazeFeatures([0.25, 0.5])),
  ];
  assert.equal(history[0].type, "gaze.sample");
  assert.equal(history[0].schema_version, 1);
  assert.equal(history[0].session_id, "test");
  assert.equal(history[0].capture_epoch, 2);
  assert.equal(history[0].x_px, 959.5);
  assert.equal(history[0].y_px, 299.75);
  const { gaze } = exportGaze(history, { sessionId: "test", captureEpoch: 2, clipStartUs: 0, clipEndUs: 800000 });
  assert.deepEqual(gaze.samples.map(sample => sample.valid), [true, false, false, true]);
  assert.equal(gaze.samples[1].uncertainty_radius_px, null);
  assert.equal(gaze.samples[2].x_px, null);
});
