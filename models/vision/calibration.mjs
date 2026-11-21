import {
  CalibrationSession, encodePoint, loadCalibration, matchesCalibration, normalizedPoint,
  predict, saveCalibration,
} from "../eye-tracking/src/calibration.mjs";
import {
  GazeMedianFilter, gazeMessage, invalidPoint, validPoint,
} from "../eye-tracking/src/timeline.mjs";
import {GAZE_MODELS} from "./series.mjs";

function featuresFor(tracker, raw) {
  if (tracker === "model1") return raw?.wet ?? null;
  if (tracker === "model2") return raw?.plane ? [...raw.plane, 0, 0, 0, 0, 0] : null;
  throw new TypeError("Unknown gaze tracker");
}

function profileStorage(storage, tracker) {
  if (!Object.hasOwn(GAZE_MODELS, tracker)) throw new TypeError("Unknown gaze tracker");
  const model = GAZE_MODELS[tracker];
  const key = name => `${name}:${model}`;
  return {
    getItem: name => storage.getItem(key(name)),
    setItem: (name, value) => storage.setItem(key(name), value),
  };
}

export function loadTrackerProfile(storage, tracker, geometry) {
  return loadCalibration(profileStorage(storage, tracker), geometry);
}

export function saveTrackerProfile(storage, tracker, geometry, profile) {
  saveCalibration(profileStorage(storage, tracker), geometry, profile);
}

// The installer owns all rendering. Both models observe the same target and source clock.
export class EnsembleCalibration {
  #sessions;

  constructor(geometry) {
    this.#sessions = Object.fromEntries(Object.keys(GAZE_MODELS).map(key => [key, new CalibrationSession(geometry)]));
  }

  get nextTarget() {
    return this.#sessions.model1.nextTarget;
  }

  showTarget(shownUs) {
    const window = this.#sessions.model1.showTarget(shownUs);
    this.#sessions.model2.showTarget(shownUs);
    return window;
  }

  observe(tracker, timeUs, raw) {
    const features = featuresFor(tracker, raw);
    this.#sessions[tracker].observe(timeUs, {features});
  }

  finishTarget(timeUs) {
    return Object.fromEntries(Object.entries(this.#sessions).map(([key, session]) =>
      [key, session.finishTarget(timeUs)]));
  }

  fit() {
    return Object.fromEntries(Object.entries(this.#sessions).map(([key, session]) => [key, session.fit()]));
  }
}

export function createGazeProjector({tracker, geometry, profile, sessionId, captureEpoch}) {
  if (!Object.hasOwn(GAZE_MODELS, tracker)) throw new TypeError("Unknown gaze tracker");
  if (profile && !matchesCalibration(profile, geometry)) throw new TypeError("Calibration does not match capture geometry");
  const filter = new GazeMedianFilter();
  return (timeUs, raw) => {
    const features = featuresFor(tracker, raw);
    const normalized = profile && features ? predict(profile.model, features) : null;
    const sample = normalizedPoint(normalized)
      ? validPoint(timeUs, encodePoint(normalized, geometry), profile.uncertaintyRadiusPx)
      : invalidPoint(timeUs);
    return gazeMessage(sessionId, captureEpoch, filter.push(sample));
  };
}
