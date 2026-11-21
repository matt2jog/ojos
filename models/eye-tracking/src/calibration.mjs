import { FEATURE_NAMES } from "./features.mjs";

export const CALIBRATION_VERSION = 1;
export const RIDGE_ALPHA = 0.05;
export const SETTLE_US = 250_000;
export const COLLECT_US = 500_000;

function targets(prefix, points) {
  return Object.freeze(points.map((point, index) => Object.freeze({
    id: prefix + (index + 1), point: Object.freeze(point),
  })));
}

export const FIT_TARGETS = targets("fit-", [
  [0.5, 0.5], [0.12, 0.12], [0.88, 0.88], [0.88, 0.12], [0.12, 0.88],
  [0.5, 0.12], [0.12, 0.5], [0.88, 0.5], [0.5, 0.88],
]);
export const VALIDATION_TARGETS = targets("validation-", [
  [0.27, 0.27], [0.73, 0.73], [0.73, 0.27], [0.27, 0.73], [0.62, 0.51],
]);

export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function medianVector(rows) {
  return rows[0].map((_, i) => quantile(rows.map(row => row[i]), 0.5));
}

function vector(value, size) {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite);
}

export function normalizedPoint(point) {
  return vector(point, 2) && point.every(value => value >= 0 && value <= 1);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function deviceKey(geometry) {
  const {
    cameraId, cameraWidth, cameraHeight, displayId, displayScale, rotationDeg,
    viewportWidth, viewportHeight,
  } = geometry;
  if (typeof cameraId !== "string" || !cameraId ||
      typeof displayId !== "string" || !displayId ||
      ![cameraWidth, cameraHeight, viewportWidth, viewportHeight].every(positiveInteger) ||
      !Number.isFinite(displayScale) || displayScale <= 0 ||
      ![0, 90, 180, 270].includes(rotationDeg)) {
    throw new TypeError("Invalid gaze calibration geometry");
  }
  return JSON.stringify([
    CALIBRATION_VERSION, cameraId, cameraWidth, cameraHeight, displayId, displayScale,
    rotationDeg, viewportWidth, viewportHeight,
  ]);
}

export function encodePoint([x, y], geometry) {
  let oriented = [x, y];
  switch (geometry.rotationDeg) {
    case 90: oriented = [1 - y, x]; break;
    case 180: oriented = [1 - x, 1 - y]; break;
    case 270: oriented = [y, 1 - x]; break;
  }
  return [oriented[0] * (geometry.viewportWidth - 1),
    oriented[1] * (geometry.viewportHeight - 1)];
}

const dot = (left, right) => left.reduce((total, value, i) => total + value * right[i], 0);
const average = values => values.reduce((a, b) => a + b, 0) / values.length;

// The ridge Gram matrix is symmetric positive definite for alpha > 0.
function choleskySolve(matrix, target) {
  const lower = matrix.map(row => row.map(() => 0));
  const forward = [];
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j <= i; j++) {
      const remainder = matrix[i][j] - dot(lower[i].slice(0, j), lower[j]);
      lower[i][j] = i === j ? Math.sqrt(remainder) : remainder / lower[j][j];
    }
    forward[i] = (target[i] - dot(lower[i].slice(0, i), forward)) / lower[i][i];
  }
  const result = forward.map(() => 0);
  for (let i = matrix.length - 1; i >= 0; i--) {
    const column = lower.slice(i + 1).map(row => row[i]);
    result[i] = (forward[i] - dot(column, result.slice(i + 1))) / lower[i][i];
  }
  return result;
}

export function fitRidge(examples, alpha = RIDGE_ALPHA) {
  const count = FEATURE_NAMES.length;
  if (!examples.length || !Number.isFinite(alpha) || alpha <= 0 ||
      !examples.every(({ features, target }) => vector(features, count) && normalizedPoint(target))) {
    throw new TypeError("Ridge requires finite features, normalized labels, and positive alpha");
  }

  const columns = FEATURE_NAMES.map((_, i) => examples.map(row => row.features[i]));
  const means = columns.map(average);
  const scales = columns.map((column, i) => Math.max(1e-4, Math.sqrt(
    average(column.map(value => (value - means[i]) ** 2)),
  )));
  const standardized = columns.map((column, i) => column.map(value => (value - means[i]) / scales[i]));
  const n = examples.length;
  const gram = standardized.map((column, i) =>
    standardized.map((other, j) => dot(column, other) / n + (i === j ? alpha : 0)));
  const outputs = [0, 1].map(axis => {
    const targets = examples.map(row => row.target[axis]);
    const intercept = average(targets);
    const centered = targets.map(value => value - intercept);
    const weights = choleskySolve(gram, standardized.map(column => dot(column, centered) / n));
    return { intercept, weights };
  });
  return { means, scales, outputs };
}

export function predict(model, features) {
  const standardized = features.map((value, i) => (value - model.means[i]) / model.scales[i]);
  return model.outputs.map(({ intercept, weights }) => intercept + dot(weights, standardized));
}

export function validateRidge(model, examples, geometry) {
  const errors = [];
  let usable = 0;
  for (const { features, target } of examples) {
    if (!features) continue;
    const point = predict(model, features);
    if (normalizedPoint(point)) usable++;
    // Preserve unclamped errors, including predictions outside the viewport.
    const [x, y] = encodePoint(point, geometry);
    const [tx, ty] = encodePoint(target, geometry);
    errors.push(Math.hypot(x - tx, y - ty));
  }

  const medianErrorPx = quantile(errors, 0.5);
  const uncertaintyRadiusPx = quantile(errors, 0.8);
  const thresholdPx = 0.08 * Math.hypot(geometry.viewportWidth, geometry.viewportHeight);
  return { usable, total: examples.length, medianErrorPx, uncertaintyRadiusPx, thresholdPx,
    passed: usable === examples.length && medianErrorPx !== null && medianErrorPx <= thresholdPx };
}

export class CalibrationSession {
  #geometry;
  #completed = [];
  #active = null;

  constructor(geometry) {
    deviceKey(geometry);
    this.#geometry = { ...geometry };
  }

  get nextTarget() {
    return [...FIT_TARGETS, ...VALIDATION_TARGETS][this.#completed.length] ?? null;
  }

  showTarget(shownUs) {
    const target = this.nextTarget;
    if (this.#active || !target) throw new Error("No new calibration target expected");
    if (!Number.isSafeInteger(shownUs) || shownUs < (this.#completed.at(-1)?.finishedUs ?? 0)) {
      throw new TypeError("Invalid target timestamp");
    }

    const collectFromUs = shownUs + SETTLE_US;
    const collectUntilUs = collectFromUs + COLLECT_US;
    if (!Number.isSafeInteger(collectUntilUs)) throw new TypeError("Invalid target window");
    this.#active = { target, collectFromUs, collectUntilUs, lastUs: -1, valid: [], frames: 0 };
    return { ...target, collectFromUs, collectUntilUs };
  }

  observe(timeUs, observation) {
    const active = this.#active;
    if (!active || !Number.isSafeInteger(timeUs) || timeUs < active.collectFromUs ||
        timeUs >= active.collectUntilUs || timeUs <= active.lastUs) return;
    active.lastUs = timeUs;
    active.frames++;
    if (vector(observation.features, FEATURE_NAMES.length)) active.valid.push(observation.features);
  }

  finishTarget(nowUs) {
    const active = this.#active;
    if (!active || !Number.isSafeInteger(nowUs) || nowUs < active.collectUntilUs) {
      throw new Error("Calibration target is still collecting");
    }
    this.#active = null;
    const { target, valid, frames } = active;
    const result = { id: target.id, target: target.point, frames, validFrames: valid.length,
      finishedUs: nowUs, features: valid.length ? medianVector(valid) : null };
    this.#completed.push(result);
    return { id: result.id, frames, validFrames: valid.length };
  }

  fit() {
    if (this.nextTarget) throw new Error("Calibration needs all fourteen target windows");
    const fit = this.#completed.slice(0, FIT_TARGETS.length);
    const validation = this.#completed.slice(FIT_TARGETS.length);
    const frames = this.#completed.reduce((sum, row) => sum + row.frames, 0);
    const validFrames = this.#completed.reduce((sum, row) => sum + row.validFrames, 0);
    const metrics = {
      frames, validFrames, coverage: frames ? validFrames / frames : 0,
      effectiveHz: frames * 1e6 / (COLLECT_US * this.#completed.length),
      validHz: validFrames * 1e6 / (COLLECT_US * this.#completed.length),
      targets: this.#completed.map(({ id, frames, validFrames }) => ({ id, frames, validFrames })),
    };
    if (fit.some(row => !row.features)) {
      return { calibration: null, metrics, reason: "missing_fit_target" };
    }
    const model = fitRidge(fit);
    const checked = validateRidge(model, validation, this.#geometry);
    Object.assign(metrics, checked);
    if (!checked.passed) return { calibration: null, metrics, reason: "validation_failed" };
    const calibration = {
      version: CALIBRATION_VERSION, deviceKey: deviceKey(this.#geometry),
      model, uncertaintyRadiusPx: checked.uncertaintyRadiusPx, metrics,
    };
    return { calibration, metrics };
  }
}

export function matchesCalibration(calibration, geometry) {
  const count = FEATURE_NAMES.length;
  const model = calibration?.model;
  return calibration?.version === CALIBRATION_VERSION &&
    calibration.deviceKey === deviceKey(geometry) &&
    Number.isFinite(calibration.uncertaintyRadiusPx) && calibration.uncertaintyRadiusPx >= 0 &&
    vector(model?.means, count) && vector(model?.scales, count) && model.scales.every(x => x > 0) &&
    Array.isArray(model.outputs) && model.outputs.length === 2 &&
    model.outputs.every(out => out && Number.isFinite(out.intercept) && vector(out.weights, count));
}

function storageKey(geometry) {
  return "ojos:gaze:" + deviceKey(geometry);
}

export function loadCalibration(storage, geometry) {
  const serialized = storage.getItem(storageKey(geometry));
  if (!serialized) return null;
  try {
    const calibration = JSON.parse(serialized);
    return matchesCalibration(calibration, geometry) ? calibration : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

export function saveCalibration(storage, geometry, calibration) {
  if (!matchesCalibration(calibration, geometry)) throw new TypeError("Invalid gaze calibration");
  storage.setItem(storageKey(geometry), JSON.stringify(calibration));
}

export function clearCalibration(storage, geometry) {
  storage.removeItem(storageKey(geometry));
}
