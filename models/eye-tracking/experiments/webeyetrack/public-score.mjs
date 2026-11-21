import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Matrix, solve } from "ml-matrix";
import { FIT_TARGETS, VALIDATION_TARGETS, fitRidge, medianVector, normalizedPoint, quantile } from "../../src/calibration.mjs";
import { extractFeatures } from "../../src/features.mjs";
import { project } from "./adapter.mjs";

const [originalRoot, experimentRoot, output] = process.argv.slice(2);
if (!output) throw new Error("Usage: node public-score.mjs ORIGINAL_OBSERVATIONS EXPERIMENT_RESULTS OUTPUT_JSON");
const allTargets = [...FIT_TARGETS, ...VALIDATION_TARGETS];
const dist = (a, b, [width, height]) => Math.hypot((a[0] - b[0]) * (width - 1), (a[1] - b[1]) * (height - 1));
const qs = (values, q) => quantile(values, q);
async function readJsonl(file) {
  return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

function fit(rows, variant, resolution, days) {
  const screen = rows[0].screen;
  const diagonal = Math.hypot(...screen);
  const bins = allTargets.map(() => []);
  for (const row of rows) {
    if (!row.features || row.camera.join("x") !== resolution || !days.includes(row.image.split("/")[0])) continue;
    const target = [row.target[0] / (screen[0] - 1), row.target[1] / (screen[1] - 1)];
    if (!normalizedPoint(target)) continue;
    const distances = allTargets.map(anchor => dist(anchor.point, target, screen));
    const min = Math.min(...distances);
    if (min <= 0.1 * diagonal) bins[distances.indexOf(min)].push({ min, target, features: row.features });
  }
  const reps = bins.map(bin => {
    const rows = bin.sort((a, b) => a.min - b.min).slice(0, 5);
    return rows.length ? { target: medianVector(rows.map(row => row.target)),
      features: medianVector(rows.map(row => row.features)) } : null;
  });
  const calib = reps.slice(0, 9);
  if (calib.some(row => !row)) return { profile: null, calib: calib.filter(Boolean).length };
  let profile;
  if (variant === "affine") {
    const x = new Matrix(calib.map(row => [row.features[0], row.features[1], 1]));
    profile = { affine: solve(x, new Matrix(calib.map(row => row.target))).transpose().to2DArray() };
  } else profile = { ridge: fitRidge(calib) };
  const validation = reps.slice(9).map(row => {
    if (!row) return null;
    const xy = project(profile, row.features);
    return { inBounds: normalizedPoint(xy), error: dist(xy, row.target, screen) };
  });
  const medianPx = qs(validation.filter(Boolean).map(row => row.error), 0.5);
  return { profile, validation: { medianPx, usable: validation.filter(row => row?.inBounds).length,
    passed: validation.every(row => row?.inBounds) && medianPx <= 0.08 * diagonal } };
}

const total = { mp: [], wetRidge: [], wetAffine: [] };
const results = [];
for (const person of ["p13", "p14"]) {
  const baseline = await readJsonl(path.join(originalRoot, person + ".jsonl"));
  const current = await readJsonl(path.join(experimentRoot, person + ".jsonl"));
  const screen = baseline[0].screen;
  const res = baseline[0].camera.join("x");
  const days = [...new Set(baseline.map(row => row.image.split("/")[0]))].sort().slice(0, 3);
  const matching = new Map(current.map(row => [row.image, row]));
  const inputs = baseline.filter(row => matching.has(row.image) && row.camera.join("x") === res)
    .map(row => ({ ...row, mp: extractFeatures(row, ...row.camera).features, wet: matching.get(row.image).wet }));
  const variants = [
    ["mp", "mp", "ridge"], ["wetRidge", "wet", "ridge"], ["wetAffine", "wet", "affine"],
  ];
  const models = Object.fromEntries(variants.map(([name, field, method]) => [name,
    fit(inputs.map(row => ({ ...row, features: row[field] })), method, res, days),
  ]));
  const comparable = inputs.filter(row => !days.includes(row.image.split("/")[0]) &&
    normalizedPoint([row.target[0] / (screen[0] - 1), row.target[1] / (screen[1] - 1)]));
  const paired = comparable.filter(row => row.mp && row.wet);
  const perModel = {};
  for (const [name, field] of variants) {
    const model = models[name];
    if (!model.profile) {
      perModel[name] = model;
      continue;
    }
    let usable = 0;
    const errors = [];
    for (const row of paired) {
      const predicted = project(model.profile, row[field]);
      const target = [row.target[0] / (screen[0] - 1), row.target[1] / (screen[1] - 1)];
      const error = dist(predicted, target, screen);
      errors.push(error);
      total[name].push(error / Math.hypot(...screen));
      if (normalizedPoint(predicted)) usable++;
    }
    perModel[name] = { validation: model.validation, pairedMedianPx: qs(errors, 0.5), p80Px: qs(errors, 0.8),
      pairedInBounds: usable, trackingUsable: comparable.filter(row => row[field]).length };
  }
  const stage = field => [0.5, 0.95].map(q => qs(current.map(row => row[field]).filter(value => value > 0), q));
  results.push({ person, selected: inputs.length, later: comparable.length, paired: paired.length, models: perModel,
    nativeTimingsMs: { mp: stage("landmarkMs"), extraPrep: stage("extraPrepareMs"), network: stage("modelMs") } });
}
const report = { people: results,
  pairedMedianDiagonal: Object.fromEntries(Object.entries(total).map(([name, errors]) => [name, qs(errors, 0.5)])) };
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
