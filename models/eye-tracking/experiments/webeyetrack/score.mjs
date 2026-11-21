import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { Matrix, solve } from "ml-matrix";
import { encodePoint, fitRidge, medianVector, normalizedPoint, quantile } from "../../src/calibration.mjs";
import { extractFeatures } from "../../src/features.mjs";
import { exportGaze } from "../../src/timeline.mjs";
import { createAdapter, project } from "./adapter.mjs";

const variants = { mp: "mp", wetAffine: "wet", wetRidge: "wet", wetRaw: "wet" };
const geometry = viewport => ({ viewportWidth: viewport[0], viewportHeight: viewport[1], rotationDeg: 0 });
const q = (values, fraction) => quantile(values.filter(Number.isFinite), fraction);
const distribution = values => ({ p50: q(values, 0.5), p95: q(values, 0.95) });
const ratio = (part, total) => total ? part / total : null;
const errorPx = (point, target, bounds) => {
  const [x, y] = encodePoint(point, bounds);
  const [tx, ty] = encodePoint(target, bounds);
  return Math.hypot(x - tx, y - ty);
};
const median = values => q(values, 0.5);

function prepare(row) {
  if (!row.camera) return row;
  const mp = extractFeatures(row, ...row.camera);
  return { ...row, mp: mp.features ?? null, mpReason: mp.reason ?? null };
}

function choose(rows, hz) {
  const period = 1e6 / hz;
  let due;
  return rows.filter(({ time }) => {
    due ??= time;
    if (time + 1e-5 < due) return false;
    due += (Math.floor((time - due + 1e-5) / period) + 1) * period;
    return true;
  });
}

function representatives(rows, targets, name, shift, paired) {
  return targets.map(target => {
    const selected = rows.filter(row => row.time >= target.start + shift &&
      row.time < target.end + shift && row[name] && (!paired || (row.mp && row.wet)));
    return { ...target, features: selected.length ? medianVector(selected.map(row => row[name])) : null,
      count: selected.length };
  });
}

function calibrate(kind, reps, bounds) {
  const fit = reps.filter(row => row.kind === "fit");
  const validation = reps.filter(row => row.kind === "validation");
  if (kind !== "wetRaw" && (fit.length !== 9 || fit.some(row => !row.features))) {
    return { model: null, targets: reps.map(({ id, count }) => ({ id, count })) };
  }
  let model = {};
  if (kind === "wetAffine") {
    const x = new Matrix(fit.map(row => [row.features[0], row.features[1], 1]));
    try {
      model.affine = solve(x, new Matrix(fit.map(row => row.point))).transpose().to2DArray();
    } catch {
      return { model: null, targets: reps.map(({ id, count }) => ({ id, count })) };
    }
  } else if (kind !== "wetRaw") {
    model.ridge = fitRidge(fit.map(row => ({ target: row.point, features: row.features })));
  }
  const checked = validation.map(row => {
    const xy = project(model, row.features);
    return { id: row.id, count: row.count, inBounds: normalizedPoint(xy),
      errorPx: xy ? errorPx(xy, row.point, bounds) : null };
  });
  const residuals = checked.map(row => row.errorPx);
  const medianPx = median(residuals);
  const passed = checked.length === 5 && checked.every(row => row.inBounds) &&
    medianPx <= 0.08 * Math.hypot(bounds.viewportWidth, bounds.viewportHeight);
  model.uncertaintyRadiusPx = q(residuals, 0.8);
  return { model, medianPx, p80Px: model.uncertaintyRadiusPx, passed,
    inBoundsTargets: checked.filter(row => row.inBounds).length, validation: checked };
}

function scoreCalibration(rows, meta, rate, shift = 0, paired = false) {
  const selected = rate === 30 ? rows : choose(rows, rate);
  return Object.fromEntries(Object.entries(variants).map(([key, name]) => [
    key, calibrate(key, representatives(selected, meta.targets, name, shift, paired), geometry(meta.viewport)),
  ]));
}

function summarizeReasoning(data, fitted, meta, hz) {
  const rows = hz === data.config.rate ? data.rows : choose(data.rows, hz);
  const bounds = geometry(meta.viewport);
  const [start, stop] = meta.windows.reasoning;
  const clipEnd = data.end ?? stop;
  const clipStart = data.start ?? start;
  const summary = {};
  for (const [key, variant] of Object.entries(variants)) {
    const fit = fitted[key];
    if (!fit?.model || fit.model.uncertaintyRadiusPx === null) continue;
    const sessionId = "fe44bbcc-41b6-4db0-8658-8f1c08507145";
    const adapt = createAdapter(sessionId, 0, bounds, fit.model);
    const points = rows.map(row => adapt(row.time, row[variant]));
    let since = null;
    let previousValid = null;
    const gaps = [];
    const betweenValid = [];
    for (const point of points) {
      if (point.valid) {
        if (since !== null) gaps.push((point.time_us - since) / 1e6);
        if (previousValid !== null) betweenValid.push((point.time_us - previousValid) / 1e3);
        previousValid = point.time_us;
        since = null;
      } else since ??= point.time_us;
    }
    if (since !== null) gaps.push((clipEnd - since) / 1e6);
    const valid = points.filter(row => row.valid).length;
    const { gaze_status, gaze } = exportGaze(points, {
      sessionId, captureEpoch: 0, clipStartUs: clipStart, clipEndUs: clipEnd,
    });
    const gridTotal = Math.ceil((clipEnd - clipStart) / 200_000);
    const reasons = {};
    for (const row of rows) {
      const reason = row[variant + "Reason"] ?? (row[variant] ? "usable" : "unavailable");
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    summary[key] = { hz, processed: rows.length, reasonCounts: reasons, valid,
      coverage: ratio(valid, rows.length), invalidP95Seconds: q(gaps, 0.95), longestInvalidSeconds: q(gaps, 1),
      betweenValidP95Ms: q(betweenValid, 0.95), gaze_status,
      gridTotal, gridValid: gaze.samples.filter(row => row.valid).length, passedValidation: fit.passed };
  }
  return summary;
}

function loadGaps(rows) {
  return rows.slice(1).map((row, i) => (row.time - rows[i].time) / 1e3);
}

function timing(run) {
  const hot = run.rows.filter(row => row.time >= run.start + 1e6);
  const stages = ["prepareMs", "landmarkMs", "extraPrepareMs", "modelMs", "postMs",
    "inputDelayMs", "queueMs", "dispatchToWorkerMs", "resultDeliveryMs", "ageMs"];
  const timing = Object.fromEntries(stages.map(field => [
    field, distribution(hot.filter(row => !["extraPrepareMs", "modelMs"].includes(field) || row.wet)
      .map(row => row[field])),
  ]));
  const busy = distribution(hot.map(row => Number.isFinite(row.started)
    ? row.ended - row.started : row.prepareMs + row.landmarkMs + row.extraPrepareMs + row.modelMs + row.postMs));
  const result = { id: run.config.id, offered: run.offered, delivered: run.rows.length, dropped: run.dropped,
    decoded: run.decoded, displayEncoded: run.displayEncoded, busy, ...timing,
    wallMs: run.wallMs, deliveredHz: run.wallMs ? run.rows.length * 1e3 / run.wallMs : null,
    deliveredGapMs: distribution(loadGaps(hot)) };
  if (run.config.paced) {
    const grid = exportGaze(run.rows.map(row => row.point), {
      sessionId: "6e11c35d-881d-5bc9-9a12-0af89fbd92d6", captureEpoch: 0,
      clipStartUs: run.start, clipEndUs: run.end,
    });
    const usable = hot.filter(row => row.point.valid);
    result.validAgeMs = distribution(usable.map(row => row.ageMs));
    result.validGapMs = distribution(loadGaps(usable));
    result.qualitySamples = run.rows.filter(row => row[run.config.variant === "mp" ? "mp" : "wet"]).length;
    result.gridValid = grid.gaze.samples.filter(point => point.valid).length;
    result.gridTotal = Math.ceil((run.end - run.start) / 2e5);
  }
  return result;
}

async function readRows(file) {
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => prepare(JSON.parse(line)));
}

async function privateResults(root) {
  const read = name => readFile(path.join(root, name), "utf8").then(JSON.parse);
  const browser = await read("browser-accuracy.json");
  const original = await read("original/index.json");
  const repeat = await read("repeat/index.json");
  const groups = [...browser.results];
  for (const file of ["browser-layout.json", "browser-pace.json", "browser-load.json", "browser-backends.json", "browser-adapt.json", "browser-load-check.json"]) {
    try { groups.push(...(await read(file)).results); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const name of ["original", "repeat", "reasoning"]) {
    for (const height of name === "reasoning" ? [720] : [720, 480]) {
      try {
        const result = await readRows(path.join(root, "native-" + name + "-" + height + ".jsonl"));
        const raw = name === "repeat" ? repeat : original;
        const windowName = name === "reasoning" ? "reasoning" : "calibration";
        const [start, end] = raw.windows[windowName];
        groups.push({ config: { id: "native-" + name + "-" + height, name: name === "reasoning" ? "original" : name,
          variant: "both", windowName, rate: name === "reasoning" ? 20 : 30, height },
        rows: result, meta: raw, start, end });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  const accuracy = {};
  const profile = {};
  const reasoning = {};
  const performance = {};
  for (const run of groups.filter(run => run.rows)) {
    const { id, windowName } = run.config;
    performance[id] = { ...timing(run), runtime: run.runtime, config: { ...run.config, profile: undefined } };
    if (windowName !== "calibration" || run.config.duration) continue;
    accuracy[id] = Object.fromEntries([30, 20, 15, 10].map(rate => [
      rate, scoreCalibration(run.rows, run.meta, rate),
    ]));
    if (run.config.adapt) {
      const adaptation = run.rows.find(row => row.adaptation)?.adaptation ?? null;
      accuracy[id] = { upstreamAdaptation: adaptation,
        wetAdapted: adaptation?.applied ? accuracy[id][run.config.rate].wetRaw : null,
        baseline: accuracy[id][run.config.rate].mp };
      continue;
    }
    accuracy[id].pairedAt30 = scoreCalibration(run.rows, run.meta, 30, 0, true);
    accuracy[id].alignmentAt30 = [-100000, 100000].map(shift => scoreCalibration(run.rows, run.meta, 30, shift));
    profile[id] = run.meta.targets.reduce((result, entry) => {
      const features = run.rows.filter(row => row.time >= entry.start && row.time < entry.end && row.mp).map(row => row.mp);
      result.push(...features);
      return result;
    }, []);
  }
  for (const run of groups.filter(run => run.rows && run.config.windowName === "reasoning" && !run.config.paced)) {
    const native = run.config.id.startsWith("native-") ? "native-" : "";
    const height = run.config.height;
    if (!accuracy[native + "repeat-" + height]) continue;
    reasoning[run.config.id] = {};
    for (const calibration of ["original", "repeat"]) {
      const id = native + calibration + "-" + height;
      const fitted = accuracy[id][run.config.rate];
      reasoning[run.config.id][calibration] = summarizeReasoning(run, fitted, original, run.config.rate);
      const roll = run.rows.flatMap(row => row.mp ? [row.mp[6] * 180 / Math.PI] : []);
      const fitRoll = profile[id].map(row => row[6] * 180 / Math.PI);
      reasoning[run.config.id][calibration].poseRoll = {
        calibrationP50Degrees: median(fitRoll), recordingP50Degrees: median(roll),
        calibrationP05Degrees: q(fitRoll, 0.05), calibrationP95Degrees: q(fitRoll, 0.95),
      };
      if (run.config.rate === 20 && height === 720) {
        for (const hz of [15, 10]) reasoning[run.config.id][calibration]["replayAt" + hz] =
          summarizeReasoning(run, accuracy[id][hz], original, hz);
      }
    }
  }
  const crossSession = {};
  for (const predictRun of groups.filter(run => run.rows && run.config.windowName === "calibration" &&
    !run.config.adapt && !run.config.matrixLayout && !run.config.duration)) {
    const sourceName = predictRun.config.name === "original" ? "repeat" : "original";
    const native = predictRun.config.id.startsWith("native-") ? "native-" : "";
    const source = accuracy[native + sourceName + "-" + predictRun.config.height]?.[20];
    if (!source) continue;
    const selected = choose(predictRun.rows, 20);
    const bounds = geometry(predictRun.meta.viewport);
    crossSession[predictRun.config.id] = Object.fromEntries(Object.entries(variants).map(([name, variant]) => {
      const fitted = source[name];
      const held = representatives(selected, predictRun.meta.targets, variant, 0, false)
        .filter(row => row.kind === "validation");
      const errors = [];
      let inBounds = 0;
      for (const row of held) {
        const projected = project(fitted?.model, row.features);
        if (!projected) continue;
        if (normalizedPoint(projected)) inBounds++;
        errors.push(errorPx(projected, row.point, bounds));
      }
      return [name, { from: sourceName, n: errors.length, inBounds, medianPx: median(errors), p80Px: q(errors, 0.8) }];
    }));
  }
  return { accuracy, reasoning, crossSession, performance, errors: groups.filter(run => run.error) };
}

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: node score.mjs LOCAL_RESULT_DIRECTORY");
  const results = await privateResults(root);
  await writeFile(path.join(root, "metrics.json"), JSON.stringify(results, null, 2) + "\n");
  for (const [id, rates] of Object.entries(results.accuracy)) {
    if (!rates[20]) {
      console.log(id, JSON.stringify({ adaptation: rates.upstreamAdaptation,
        medianPx: rates.wetAdapted?.medianPx, passed: rates.wetAdapted?.passed }));
      continue;
    }
    const values = Object.entries(rates[20]).map(([model, value]) => [
      model, Math.round(value.medianPx ?? 0), value.passed, value.inBoundsTargets,
    ]);
    console.log(id, JSON.stringify(values));
  }
}

await main();
