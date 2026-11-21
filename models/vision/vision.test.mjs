import assert from "node:assert/strict";
import test from "node:test";
import {
  EnsembleCalibration, VisionFrameDispatcher, VisionSession, createGazeProjector, exportVisionSeries,
  loadTrackerProfile, saveTrackerProfile,
} from "./index.mjs";

const sessionId = "77510d91-432d-4c51-b2e6-59cb27986589";
const captureEpoch = 0;
const key = {session_id: sessionId, capture_epoch: captureEpoch};
const options = {sessionId, captureEpoch, clipStartUs: 1_000_000, clipEndUs: 1_600_000, width: 100, height: 100};
const gaze = (time_us, x_px, y_px, radius, valid = true) =>
  ({...key, time_us, x_px, y_px, uncertainty_radius_px: radius, valid});
const score = (time_us, confidence, valid = true) =>
  ({...key, time_us, confidence, confidence_raw: confidence, valid});

test("clip export retains both model observations and bounds on a half-open grid", () => {
  const series = exportVisionSeries({...options,
    model1: [gaze(980_000, 5, 10, 20), gaze(1_200_000, 0, 1, 3)],
    model2: [gaze(1_010_000, 100 - 1, 92, 10), {...gaze(1_200_000, 30, 5, 8), capture_epoch: 1}],
    confusion: [score(990_000, 0), score(1_200_000, null, false)],
  });
  assert.equal(series.gaze_status, "available");
  const [first, second, last] = series.gaze.samples;
  assert.deepEqual(series.gaze.samples.map(item => item.time_us), [0, 200_000, 400_000]);
  assert.deepEqual(first.maxbox, {x: 0, y: 0, w: 100, h: 100});
  assert.equal(first.average_x, 52);
  assert.equal(first.average_y, 51);
  assert.equal(first.confidence, 0);
  assert.equal(first.model2_offset_us, 10_000);
  assert.equal(second.fusion_mode, "model1_only");
  assert.equal(second.average_x, 0);
  assert.equal(second.confidence, null);
  assert.equal(last.maxbox, null);
});

test("invalid, future confusion, stale and unaligned gaze remain distinguishable", () => {
  const {gaze: series} = exportVisionSeries({...options,
    model1: [gaze(910_000, 12, 10, 4), gaze(1_190_000, null, null, null, false), gaze(1_239_000, 72, 12, 4)],
    model2: [gaze(1_089_000, 25, 10, 6), gaze(1_370_000, 25, 10, 6)],
    confusion: [score(1_001_000, 0.7)],
  });
  assert.equal(series.samples[0].x_model2, 25);
  assert.equal(series.samples[0].fusion_mode, "model1_only");
  assert.equal(series.samples[0].confidence, null);
  assert.equal(series.samples[1].x_model1, null);
  assert.equal(series.samples[2].fusion_mode, "model2_only");
  assert.equal(series.samples[2].confidence, null);
});

const geometry = {cameraId: "camera", cameraWidth: 1280, cameraHeight: 720, displayId: "display",
  displayScale: 1, rotationDeg: 0, viewportWidth: 1920, viewportHeight: 1200};

test("calibration fits both trackers and updates a live session without clearing its history", async () => {
  const wizard = new EnsembleCalibration(geometry);
  let t = 1000;
  let targets = 0;
  while (wizard.nextTarget) {
    const {point: [x, y], collectFromUs, collectUntilUs} = wizard.showTarget(t);
    wizard.observe("model1", collectFromUs, {wet: [x, y, 0, 0, 0, 0, 0]});
    wizard.observe("model2", collectFromUs, {plane: [x * 100, y * 100]});
    assert.equal(wizard.finishTarget(collectUntilUs).model2.validFrames, 1);
    t = collectUntilUs;
    targets++;
  }
  assert.equal(targets, 14);
  const profiles = wizard.fit();
  const memory = new Map();
  const storage = {setItem: (k,v) => memory.set(k,v), getItem: k => memory.get(k)};
  for (const tracker of ["model1", "model2"]) {
    saveTrackerProfile(storage, tracker, geometry, profiles[tracker].calibration);
    assert.deepEqual(loadTrackerProfile(storage, tracker, geometry), profiles[tracker].calibration);
  }
  assert.equal(memory.size, 2);
  assert.equal(loadTrackerProfile(storage, "model1", {...geometry, displayId: "second"}), null);
  const project = createGazeProjector({tracker: "model2", geometry, profile: profiles.model2.calibration,
    sessionId, captureEpoch});
  assert.equal(project(9_000_000, {plane:[50, 50]}).valid, true);
  assert.equal(project(9_200_000, {plane:null}).valid, false);

  let now = 1_000_000;
  const live = new VisionSession({sessionId, captureEpoch, geometry, clockUs: () => now,
    workers: {model2: async () => ({plane: [50, 50]})}});
  const frame = {clone: () => ({close() {}})};
  live.submit(frame, now, 1);
  await new Promise(resolve => setImmediate(resolve));
  live.updateProfiles({model2: profiles.model2.calibration});
  now += 200_000;
  live.submit(frame, now, 2);
  await new Promise(resolve => setImmediate(resolve));
  const {gaze} = live.exportClip(1_000_000, 1_400_000);
  assert.equal(gaze.samples[0].fusion_mode, "unavailable");
  assert.equal(gaze.samples[1].fusion_mode, "model2_only");
  live.close();
});

test("dispatcher sheds queued frames and discards late gaze replies", async () => {
  let clock = 0;
  let completed;
  let closes = 0;
  const reports = [];
  const sent = [];
  const frame = {clone: () => ({close: () => closes++})};
  const dispatcher = new VisionFrameDispatcher({workers: {model1: packet => {
    sent.push(packet.frameId);
    return new Promise(resolve => { completed = resolve; });
  }}, clockUs: () => clock, onResult: reply => reports.push(reply)});
  dispatcher.submit(frame, 0, 0);
  dispatcher.submit(frame, 70_000, 1);
  clock = 150_000;
  dispatcher.submit(frame, 150_000, 2);
  completed({wet: [0]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports[0].late, true);
  assert.equal(reports[0].result, null);
  assert.deepEqual(sent, [0, 2]);
  completed({wet: [1]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports[1].late, false);
  assert.equal(closes, 3);
  assert.equal(dispatcher.stats().model1.dropped, 1);
  dispatcher.close();
});

test("a session routes the score into its clip sidecar before publishing an event", async () => {
  const exports = [];
  const errors = [];
  const vision = new VisionSession({sessionId, captureEpoch, geometry,
    clockUs: () => options.clipStartUs,
    workers: {confusion: async ({timeUs}) => ({
      sample: {...score(timeUs, 0.85), model_version: "confusion-demo"}, interval: {event_id: "ready"},
    })},
    onError: error => errors.push(error),
    onInterval: (interval, timeUs) => exports.push([interval, timeUs, vision.exportClip(timeUs,timeUs+200_000)]),
  });
  vision.submit({clone: () => ({close() {}})}, options.clipStartUs, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(exports[0][0].event_id, "ready");
  assert.equal(exports[0][1], options.clipStartUs);
  assert.equal(exports[0][2].gaze.models.confusion, "confusion-demo");
  assert.equal(exports[0][2].gaze.samples[0].confidence, 0.85);
  assert.equal(exports[0][2].gaze_status, "unavailable");
  vision.close();
});
