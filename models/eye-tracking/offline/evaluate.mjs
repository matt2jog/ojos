import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FIT_TARGETS, VALIDATION_TARGETS, RIDGE_ALPHA, encodePoint, normalizedPoint,
  quantile, medianVector, fitRidge, validateRidge, predict,
} from "../src/calibration.mjs";
import { extractFeatures } from "../src/features.mjs";

const config = JSON.parse(await readFile(new URL("mpiifacegaze.json", import.meta.url)));
const [observations, output] = process.argv.slice(2);
if (!observations || !output) throw new Error("Usage: node offline/evaluate.mjs OBSERVATION_DIR RUN_DIR");

const anchors = [...FIT_TARGETS, ...VALIDATION_TARGETS];
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const cameraKey = camera => camera.join("x");
const distancePx = (prediction, target, geometry) => {
  const [x, y] = encodePoint(prediction, geometry);
  const [tx, ty] = encodePoint(target, geometry);
  return Math.hypot(x - tx, y - ty);
};
const diagonal = geometry => Math.hypot(geometry.viewportWidth, geometry.viewportHeight);

function representatives(rows, geometry) {
  const bins = new Map(anchors.map(({ id }) => [id, []]));
  for (const row of rows) {
    if (!row.features) continue;
    let best = null;
    for (const anchor of anchors) {
      const distance = distancePx(row.target, anchor.point, geometry);
      if (!best || distance < best.distance) best = { id: anchor.id, distance };
    }
    if (best.distance <= config.maxAnchorDistanceDiagonal * diagonal(geometry)) {
      bins.get(best.id).push({ row, distance: best.distance });
    }
  }
  return anchors.map(({ id }) => {
    const members = bins.get(id).sort((left, right) => left.distance - right.distance)
      .slice(0, config.samplesPerAnchor).map(({ row }) => row);
    return { id, count: members.length,
      target: members.length ? medianVector(members.map(row => row.target)) : null,
      features: members.length ? medianVector(members.map(row => row.features)) : null };
  });
}

function readPerson(rows, person) {
  const [width, height] = rows[0].screen;
  const sizes = new Map();
  for (const row of rows) {
    if (row.person !== person || row.screen[0] !== width || row.screen[1] !== height) {
      throw new Error("Inconsistent participant or display metadata");
    }
    const size = cameraKey(row.camera);
    sizes.set(size, (sizes.get(size) ?? 0) + 1);
  }
  const mostCommonSize = [...sizes].sort((a, b) => b[1] - a[1])[0][0];
  const geometry = { viewportWidth: width, viewportHeight: height, rotationDeg: 0 };
  const records = [];
  const reasons = {};
  let resolutionExcluded = 0;
  let outOfScreenLabels = 0;
  for (const row of rows) {
    if (cameraKey(row.camera) !== mostCommonSize) {
      resolutionExcluded++;
      continue;
    }
    const target = [row.target[0] / (width - 1), row.target[1] / (height - 1)];
    if (!normalizedPoint(target)) {
      outOfScreenLabels++;
      continue;
    }
    const observation = extractFeatures(row, ...row.camera);
    if (observation.reason) reasons[observation.reason] = (reasons[observation.reason] ?? 0) + 1;
    records.push({ day: row.image.split("/")[0], target, ...observation });
  }

  const days = [...new Set(records.map(row => row.day))].sort();
  const fitDays = days.slice(0, config.calibrationDays);
  const later = records.filter(row => !fitDays.includes(row.day));
  const early = records.filter(row => fitDays.includes(row.day));
  const targets = representatives(early, geometry);
  const fit = targets.slice(0, FIT_TARGETS.length);
  const validation = targets.slice(FIT_TARGETS.length);
  const model = fit.every(row => row.features) ? fitRidge(fit) : null;
  const gate = model ? validateRidge(model, validation, geometry) : null;
  return {
    person, geometry, fit, model, gate, later,
    counts: {
      totalImages: rows.length, resolutionExcluded, outOfScreenLabels,
      eligibleImages: records.length, featuresUsable: records.filter(row => row.features).length,
      featureRejectReasons: reasons, cameraResolution: mostCommonSize,
      fitDays, laterDays: days.length - fitDays.length,
      fitAnchorCounts: fit.map(row => row.count), validationAnchorCounts: validation.map(row => row.count),
    },
  };
}

function summarizeErrors(errors) {
  return {
    medianPx: quantile(errors.map(row => row.pixel), 0.5),
    p80Px: quantile(errors.map(row => row.pixel), 0.8),
    medianDiagonalRatio: quantile(errors.map(row => row.ratio), 0.5),
    p80DiagonalRatio: quantile(errors.map(row => row.ratio), 0.8),
  };
}

function evaluatePerson(info, evaluate, radius = null) {
  const errors = [];
  let valid = 0;
  let withinRadius = 0;
  for (const row of info.later) {
    if (!row.features) continue;
    const point = evaluate(row.features);
    const pixel = distancePx(point, row.target, info.geometry);
    if (normalizedPoint(point)) {
      valid++;
      if (radius !== null && pixel <= radius) withinRadius++;
    }
    errors.push({ pixel, ratio: pixel / diagonal(info.geometry) });
  }
  return {
    metrics: { predicted: errors.length, valid, cover: info.later.length ? valid / info.later.length : 0,
      withinInitialRadius: radius === null ? null : withinRadius,
      ...summarizeErrors(errors) },
    errors,
  };
}

const people = [];
for (let index = 0; index < config.participantCount; index++) {
  const person = "p" + String(index).padStart(2, "0");
  const lines = (await readFile(path.join(observations, person + ".jsonl"), "utf8")).trim().split("\n");
  people.push(readPerson(lines.map(line => JSON.parse(line)), person));
}
const extraction = JSON.parse(await readFile(path.join(observations, "extraction.json")));
if (extraction.images !== people.reduce((sum, row) => sum + row.counts.totalImages, 0) ||
    extraction.data_md5 !== config.md5) throw new Error("Unexpected extraction manifest");

const fitted = people.filter(row => row.model);
if (fitted.length < 2) throw new Error("Too few people with nine supported targets");
const all = { personal: [], leaveOnePersonOut: [], center: [] };
const perPerson = people.map(info => {
  const pooled = fitRidge(fitted.filter(row => row.person !== info.person).flatMap(row => row.fit));
  const personal = info.model ? evaluatePerson(info, features => predict(info.model, features),
    info.gate.uncertaintyRadiusPx) : null;
  const leaveOnePersonOut = evaluatePerson(info, features => predict(pooled, features));
  const center = evaluatePerson(info, () => [0.5, 0.5]);
  if (personal) {
    all.personal.push(...personal.errors);
    all.leaveOnePersonOut.push(...leaveOnePersonOut.errors);
    all.center.push(...center.errors);
  }
  return { person: info.person, screen: [info.geometry.viewportWidth, info.geometry.viewportHeight],
    ...info.counts, gate: info.gate, laterImages: info.later.length,
    personal: personal?.metrics ?? null, leaveOnePersonOut: leaveOnePersonOut.metrics, center: center.metrics };
});

const ratioMedians = perPerson.filter(row => row.personal)
  .map(row => row.personal.medianDiagonalRatio);
const passed = perPerson.filter(row => row.gate?.passed);
const qualifiedErrors = passed.map(row => row.personal.medianDiagonalRatio);
const qualifiedValid = passed.reduce((sum, row) => sum + row.personal.valid, 0);
const qualifiedWithinRadius = passed.reduce((sum, row) => sum + row.personal.withinInitialRadius, 0);
const paired = perPerson.filter(row => row.personal);
const pairedLaterImages = paired.reduce((sum, row) => sum + row.laterImages, 0);
const pairedCoverage = Object.fromEntries(Object.keys(all).map(name => [
  name, paired.reduce((sum, row) => sum + row[name].valid, 0) / pairedLaterImages,
]));
const summary = {
  experiment: "MPIIFaceGaze still-image calibration proxy v1",
  config, ridgeAlpha: RIDGE_ALPHA,
  sourceImages: extraction.images,
  resolvedValidLabels: perPerson.reduce((sum, row) => sum + row.eligibleImages, 0),
  featureUsableImages: perPerson.reduce((sum, row) => sum + row.featuresUsable, 0),
  passedInitialGate: passed.length,
  fittedParticipants: fitted.length,
  participants: people.length,
  pairedLaterImages, laterFramesPaired: all.personal.length, pairedCoverage,
  qualifiedValidLaterPredictions: qualifiedValid,
  qualifiedWithinInitialRadius: qualifiedWithinRadius,
  meanParticipantMedianDiagonalRatio: mean(ratioMedians),
  qualifiedMedianParticipantLaterDiagonalRatio: quantile(qualifiedErrors, 0.5),
  pairedLaterDays: Object.fromEntries(Object.entries(all).map(([name, errors]) => [
    name, summarizeErrors(errors),
  ])),
  perPerson,
};
await writeFile(path.join(output, "report.json"), JSON.stringify(summary, null, 2) + "\n");
await writeFile(path.join(output, "research-fits.json"), JSON.stringify(fitted.map(info => ({
  person: info.person, model: info.model, gate: info.gate, screen: info.geometry,
})), null, 2) + "\n");
console.log(JSON.stringify({ ...summary, perPerson: undefined }, null, 2));
