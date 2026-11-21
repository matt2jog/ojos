import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  FIT_TARGETS, VALIDATION_TARGETS, encodePoint, fitRidge, medianVector, normalizedPoint,
  predict, quantile, validateRidge,
} from "../../src/calibration.mjs";
import { extractFeatures } from "../../src/features.mjs";
import { EXPORT_STEP_US, GazeMedianFilter, exportGaze, gazeMessage,
  invalidPoint, validPoint } from "../../src/timeline.mjs";

const variants = ["mediaPipe", "webEyeTrack", "slopes", "plane"];
const anchors = [...FIT_TARGETS, ...VALIDATION_TARGETS];
const features2d = values => values && [...values, 0, 0, 0, 0, 0];
const readJson = async file => JSON.parse(await readFile(file, "utf8"));

async function readLines(file) {
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function geometry([viewportWidth, viewportHeight]) {
  return { viewportWidth, viewportHeight, rotationDeg: 0 };
}

function radial(a, b, bounds) {
  const [ax, ay] = encodePoint(a, bounds);
  const [bx, by] = encodePoint(b, bounds);
  return Math.hypot(ax - bx, ay - by);
}

function summarizeMetric(values) {
  return Object.fromEntries([["median", .5], ["p95", .95]].map(([label, q]) => [label, quantile(values, q)]));
}

function stages(rows) {
  const accepted = rows.filter(row => row.slopes);
  const totals = accepted.map(row => Object.values(row.stage_ms).reduce((a, b) => a + b, 0));
  return {
    frames: rows.length, usable: accepted.length,
    serviceOnUsable: summarizeMetric(totals),
    stageMs: Object.fromEntries(["frame", "landmarks", "geometry", "model", "post"].map(key => [
      key, summarizeMetric(accepted.map(row => row.stage_ms[key])),
    ])),
    reasons: rows.reduce((result, row) => {
      if (row.reason) result[row.reason] = (result[row.reason] ?? 0) + 1;
      return result;
    }, {}),
  };
}

function studyTargets(groups, variant, bounds) {
  const samples = groups.map(({ target, rows }) => {
    const usable = rows.filter(row => row[variant]);
    return { target: target ?? (usable.length ? medianVector(usable.map(row => row.point)) : null),
      features: usable.length ? medianVector(usable.map(row => row[variant])) : null,
      count: usable.length };
  });
  const fit = samples.slice(0, FIT_TARGETS.length);
  const validation = samples.slice(FIT_TARGETS.length);
  return {
    model: fit.every(row => row.features) ? fitRidge(fit) : null,
    validation, samples: samples.map(row => row.count), bounds,
  };
}

function check(fit, validation = fit.validation, bounds = fit.bounds) {
  if (!fit.model) return { unavailable: true, samples: fit.samples };
  const gate = validateRidge(fit.model, validation, bounds);
  return { ...gate, samples: fit.samples };
}

function rankPublic(rows, bounds) {
  const bins = anchors.map(() => []);
  for (const row of rows) {
    const distances = anchors.map(anchor => radial(anchor.point, row.point, bounds));
    const distance = Math.min(...distances);
    if (distance <= .1 * Math.hypot(bounds.viewportWidth, bounds.viewportHeight)) {
      bins[distances.indexOf(distance)].push({ ...row, distance });
    }
  }
  return bins.map(rows => ({ rows: rows.sort((a, b) => a.distance - b.distance) }));
}

function calibrationPublic(bins, name, bounds) {
  return studyTargets(bins.map(({ rows }) => ({
    rows: rows.filter(row => row[name]).slice(0, 5),
  })), name, bounds);
}

async function publicStudy(xgazePath, baselineFolder, webEyeFolder) {
  const data = await readLines(xgazePath);
  const summary = {};
  const pool = Object.fromEntries(variants.map(name => [name, []]));
  for (const person of ["p13", "p14"]) {
    const baseline = await readLines(path.join(baselineFolder, person + ".jsonl"));
    const webEye = new Map((await readLines(path.join(webEyeFolder, person + ".jsonl"))).map(row => [row.image, row]));
    const names = new Map(baseline.map(row => [row.image, row]));
    const days = [...new Set(baseline.map(row => row.image.split("/")[0]))].sort().slice(0, 3);
    const bounds = geometry(baseline[0].screen);
    const resolution = baseline[0].camera.join("x");
    const rows = data.filter(row => row.person === person && row.camera.join("x") === resolution).map(row => {
      const raw = names.get(row.image);
      if (!raw) throw new Error("Unrecognized public image " + row.image);
      return { day: row.image.split("/")[0], point: [
        row.target[0] / (bounds.viewportWidth - 1), row.target[1] / (bounds.viewportHeight - 1),
      ], mediaPipe: extractFeatures(raw, ...raw.camera).features, webEyeTrack: webEye.get(row.image)?.wet,
      slopes: features2d(row.slopes), plane: features2d(row.plane) };
    }).filter(row => normalizedPoint(row.point));
    const bins = rankPublic(rows.filter(row => days.includes(row.day)), bounds);
    const later = rows.filter(row => !days.includes(row.day));
    const paired = later.filter(row => variants.every(name => row[name]));
    const models = {};
    for (const name of variants) {
      const fit = calibrationPublic(bins, name, bounds);
      const gate = check(fit);
      if (!fit.model) {
        models[name] = { gate };
        continue;
      }
      const points = paired.map(row => predict(fit.model, row[name]));
      const errors = points.map((point, i) => radial(point, paired[i].point, bounds));
      pool[name].push(...errors.map(error => error / Math.hypot(bounds.viewportWidth, bounds.viewportHeight)));
      models[name] = { gate, trackingUsable: later.filter(row => row[name]).length,
        inBounds: points.filter(normalizedPoint).length, medianPx: quantile(errors, .5), p80Px: quantile(errors, .8) };
    }
    summary[person] = { days, eligibleLater: later.length, paired: paired.length, models };
  }
  return { people: summary, pairedMedianDiagonal: Object.fromEntries(
    variants.map(name => [name, quantile(pool[name], .5)])), runtime: stages(data),
  };
}

function prepareLocal(rows) {
  return rows.map(row => ({
    ...row, slopes: features2d(row.slopes), plane: features2d(row.plane),
    mediaPipe: extractFeatures(row, ...row.camera).features,
  }));
}

function localCalibrations(rows, meta) {
  const bins = meta.targets.map(({ point, start, end }) => ({
    target: point, rows: rows.filter(row => row.time >= start && row.time < end),
  }));
  return Object.fromEntries(["mediaPipe", "slopes", "plane"].map(name => [
    name, studyTargets(bins, name, geometry(meta.viewport)),
  ]));
}

function reasoningStats(rows, fit, name, [start, end]) {
  if (!fit.model) return { unavailable: true };
  const sessionId = "0d0449ea-71c0-4630-8a9f-d53081176193";
  const captureEpoch = 0;
  const gate = check(fit);
  const uncertainty = gate.uncertaintyRadiusPx;
  if (!Number.isFinite(uncertainty)) return { unavailable: true };
  const filter = new GazeMedianFilter();
  const history = rows.map(row => {
    const point = row[name] && predict(fit.model, row[name]);
    const observation = normalizedPoint(point)
      ? validPoint(row.time, encodePoint(point, fit.bounds), uncertainty)
      : invalidPoint(row.time);
    return gazeMessage(sessionId, captureEpoch, filter.push(observation));
  });
  const grid = exportGaze(history, { sessionId, captureEpoch, clipStartUs: start, clipEndUs: end });
  const gridValid = grid.gaze.samples.filter(row => row.valid).length;
  let invalidSince = null;
  const dropouts = [];
  for (const row of history) {
    if (row.valid) {
      if (invalidSince !== null) dropouts.push((row.time_us - invalidSince) / 1e6);
      invalidSince = null;
    } else invalidSince ??= row.time_us;
  }
  if (invalidSince !== null) dropouts.push((end - invalidSince) / 1e6);
  return { rows: rows.length, valid: history.filter(row => row.valid).length,
    gridValid, gridTotal: Math.ceil((end - start) / EXPORT_STEP_US),
    longestInvalidSeconds: quantile(dropouts, 1), p95InvalidSeconds: quantile(dropouts, .95),
    gatePassed: gate.passed };
}

async function localStudy(stage, indexes) {
  const sessions = {};
  for (const name of ["original", "repeat"]) {
    sessions[name] = { meta: await readJson(path.join(indexes, name, "index.json")) };
  }
  const fits = {};
  const summary = {};
  for (const height of ["720", "480"]) {
    const group = {};
    const names = ["original", "repeat"];
    let observations;
    try {
      observations = await Promise.all(names.map(name =>
        readLines(path.join(stage, name + "-" + height + ".jsonl"))));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const [index, name] of names.entries()) {
      const rows = prepareLocal(observations[index]);
      const meta = sessions[name].meta;
      fits[name + "-" + height] = localCalibrations(rows, meta);
      group[name] = { runtime: stages(rows) };
    }
    for (const name of ["original", "repeat"]) {
      const other = name === "original" ? "repeat" : "original";
      group[name].score = Object.fromEntries(Object.entries(fits[name + "-" + height]).map(([model, fit]) => [
        model, { own: check(fit), transfer: check(fits[other + "-" + height][model], fit.validation, fit.bounds) },
      ]));
    }
    summary[height] = group;
  }
  if (!summary["720"]) throw new Error("Both 720p calibration passes are required");
  try {
    const rows = prepareLocal(await readLines(path.join(stage, "reasoning-720.jsonl")));
    summary.reasoning = { runtime: stages(rows) };
    for (const name of ["original", "repeat"]) {
      summary.reasoning[name] = Object.fromEntries(Object.entries(fits[name + "-720"]).map(([model, fit]) => [
        model, reasoningStats(rows, fit, model, sessions.original.meta.windows.reasoning),
      ]));
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return summary;
}

const [mode, a, b, c, d] = process.argv.slice(2);
if (mode !== "public" && mode !== "local") {
  throw new Error("Use public XGAZE_JSONL MP_DIR WEBEYETRACK_DIR OUTPUT or local WINDOWS_RUN INDEX_DIR OUTPUT.");
}
const result = mode === "public" ? await publicStudy(a, b, c) : await localStudy(a, b);
await writeFile(mode === "public" ? d : c, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
