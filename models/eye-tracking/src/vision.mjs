import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { deviceKey, encodePoint, matchesCalibration, normalizedPoint, predict } from "./calibration.mjs";
import { extractFeatures, fromMediaPipe, TRACKING_OPTIONS } from "./features.mjs";
import { GazeMedianFilter, gazeMessage, invalidPoint, validPoint } from "./timeline.mjs";

export const GAZE_PERIOD_US = 50_000;

export async function openFaceLandmarker({ wasmRoot, modelUrl, runningMode = "VIDEO" }) {
  const files = await FilesetResolver.forVisionTasks(wasmRoot);
  return FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
    runningMode,
    ...TRACKING_OPTIONS,
  });
}

// Call once per epoch from the vision worker. The desktop owns and timestamps the frames.
export async function createGazePipeline({ sessionId, captureEpoch, geometry, calibration, assets }) {
  if (typeof sessionId !== "string" || !sessionId ||
      !Number.isSafeInteger(captureEpoch) || captureEpoch < 0) {
    throw new TypeError("Invalid gaze epoch");
  }
  deviceKey(geometry);
  const fixedGeometry = { ...geometry };
  const detector = await openFaceLandmarker(assets);
  const filter = new GazeMedianFilter();
  let readyCalibration = null;
  let lastUs = -1;
  let nextDueUs = null;
  let closed = false;
  const counts = { framesSeen: 0, cadenceSkipped: 0, inferred: 0, validFeatures: 0,
    validGaze: 0, invalidReasons: {}, inferenceMs: 0, firstTimeUs: null, lastTimeUs: null };

  function recordTime(timeUs) {
    if (closed) throw new Error("Gaze pipeline is closed");
    if (!Number.isSafeInteger(timeUs) || timeUs <= lastUs) {
      throw new RangeError("Expected a fresh frame in session microseconds");
    }
    lastUs = timeUs;
  }

  function makeOutput(timeUs, observation) {
    let point = invalidPoint(timeUs);
    let reason = observation.reason;
    if (observation.features) {
      counts.validFeatures++;
      reason = "uncalibrated";
      if (readyCalibration) {
        const predicted = predict(readyCalibration.model, observation.features);
        if (normalizedPoint(predicted)) {
          point = validPoint(timeUs, encodePoint(predicted, fixedGeometry),
            readyCalibration.uncertaintyRadiusPx);
          counts.validGaze++;
          reason = null;
        } else {
          reason = "outside_viewport";
        }
      }
    }
    if (reason) counts.invalidReasons[reason] = (counts.invalidReasons[reason] ?? 0) + 1;
    const filtered = filter.push(point);
    return { message: gazeMessage(sessionId, captureEpoch, filtered), observation, reason };
  }

  function setCalibration(next) {
    if (next && !matchesCalibration(next, fixedGeometry)) {
      throw new TypeError("Calibration does not match this epoch");
    }
    readyCalibration = next ? structuredClone(next) : null;
    filter.reset();
  }

  try {
    setCalibration(calibration);
  } catch (error) {
    detector.close();
    throw error;
  }

  return {
    setCalibration,
    processFrame(frame, timeUs) {
      recordTime(timeUs);
      counts.framesSeen++;
      const width = frame.displayWidth ?? frame.videoWidth ?? frame.width;
      const height = frame.displayHeight ?? frame.videoHeight ?? frame.height;
      if (width !== fixedGeometry.cameraWidth || height !== fixedGeometry.cameraHeight) {
        throw new RangeError("Camera frame geometry changed. Start a new capture epoch.");
      }

      nextDueUs ??= timeUs;
      if (timeUs < nextDueUs) {
        counts.cadenceSkipped++;
        return null;
      }
      nextDueUs += (Math.floor((timeUs - nextDueUs) / GAZE_PERIOD_US) + 1) * GAZE_PERIOD_US;
      const started = performance.now();
      const raw = fromMediaPipe(detector.detectForVideo(frame, timeUs / 1000));
      counts.inferenceMs += performance.now() - started;
      counts.inferred++;
      counts.firstTimeUs ??= timeUs;
      counts.lastTimeUs = timeUs;
      return makeOutput(timeUs, extractFeatures(raw, width, height));
    },
    trackingLost(timeUs) {
      recordTime(timeUs);
      return makeOutput(timeUs, { reason: "tracking_lost" });
    },
    stats() {
      const spanUs = counts.lastTimeUs - counts.firstTimeUs;
      return { ...counts, invalidReasons: { ...counts.invalidReasons },
        effectiveHz: spanUs > 0 ? (counts.inferred - 1) * 1e6 / spanUs : 0,
        meanInferenceMs: counts.inferred ? counts.inferenceMs / counts.inferred : null };
    },
    close() {
      if (closed) return;
      closed = true;
      detector.close();
    },
  };
}
