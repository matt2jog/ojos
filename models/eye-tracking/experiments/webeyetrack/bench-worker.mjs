import * as tf from "@tensorflow/tfjs";
import { setWasmPaths, setThreadsCount } from "@tensorflow/tfjs-backend-wasm";
import WebEyeTrack from "webeyetrack-source/WebEyeTrack";
import BlazeGaze from "webeyetrack-source/BlazeGaze";
import { computeEAR } from "webeyetrack-source/utils/mathUtils";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { fromMediaPipe, extractFeatures, TRACKING_OPTIONS } from "../../src/features.mjs";
import { createAdapter, gazeFeatures } from "./adapter.mjs";

let detector, wet, blaze, canvas, context, dimensions, variant, matrixLayout, adapter;
let fitTargets, fitEnd, supports, adaptation;
const now = () => performance.timeOrigin + performance.now();

async function start(config) {
  variant = config.variant;
  matrixLayout = config.matrixLayout;
  fitTargets = config.fitTargets;
  fitEnd = fitTargets?.at(-1)?.end;
  supports = new Map();
  const assets = new URL(config.assetsBaseUrl ?? "./", self.location.href);
  if (!assets.pathname.endsWith("/")) assets.pathname += "/";
  const asset = name => new URL(name, assets).href;
  const files = await FilesetResolver.forVisionTasks(asset("mp"));
  detector = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: asset("face_landmarker.task"), delegate: config.landmarkDelegate ?? "CPU" },
    runningMode: "VIDEO", ...TRACKING_OPTIONS,
  });
  const [width, height] = config.dimensions;
  dimensions = [width, height];
  canvas = new OffscreenCanvas(width, height);
  context = canvas.getContext("2d", { willReadFrequently: variant !== "mp" });

  if (variant !== "mp") {
    if (config.backend === "wasm") {
      setWasmPaths(asset("tf/"));
      setThreadsCount(config.tfThreads ?? 1);
    }
    if (!(await tf.setBackend(config.backend))) throw new Error("Cannot enable " + config.backend);
    await tf.ready();
    wet = new WebEyeTrack();
    blaze = fitTargets ? wet.blazeGaze : new BlazeGaze();
    await blaze.loadModel(asset("").replace(/\/$/, ""));
  }
  adapter = createAdapter(config.sessionId ?? "6e11c35d-881d-5bc9-9a12-0af89fbd92d6",
    config.captureEpoch ?? 0, config.geometry, config.profile);
  const gl = config.backend === "webgl" && variant !== "mp" ? tf.backend().getGPGPUContext?.().gl : null;
  const debug = gl?.getExtension("WEBGL_debug_renderer_info");
  return { tfBackend: variant === "mp" ? null : tf.getBackend(), threads: config.tfThreads ?? 1,
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    landmarkDelegate: config.landmarkDelegate ?? "CPU" };
}

async function step(frame) {
  if (fitEnd !== undefined && frame.timestamp >= fitEnd && !adaptation) {
    const rows = fitTargets.map(target => supports.get(target.id));
    try {
      if (rows.some(row => !row)) throw new Error("A fit target has no open-eye frame");
      const start = now();
      await wet.adapt(rows.map(row => row.patch), rows.map(row => row.head),
        rows.map(row => row.face), rows.map(row => row.target.point.map(value => value - 0.5)), 1);
      adaptation = { applied: true, fitMs: now() - start };
    } catch (error) {
      adaptation = { applied: false, error: String(error) };
    } finally {
      supports.clear();
    }
  }
  const started = now();
  const [width, height] = dimensions;
  const resized = width !== frame.displayWidth || height !== frame.displayHeight;
  let input = frame;
  if (resized || variant !== "mp") {
    context.drawImage(frame, 0, 0, width, height);
    if (resized || variant !== "mp") input = canvas;
  }
  const beforeLandmarks = now();
  const results = detector.detectForVideo(input, frame.timestamp / 1000);
  const afterLandmarks = now();
  const raw = fromMediaPipe(results);
  const mp = extractFeatures(raw, width, height);
  let wetReason = null;
  let observation = null;
  let wetPrepMs = 0;
  let networkMs = 0;
  let geometryValues = null;
  if (variant !== "mp") {
    if (raw.faces !== 1 || !raw.matrix) {
      wetReason = raw.faces === 0 ? "tracking_lost" : raw.faces !== 1 ? "ambiguous_face" : "missing_pose";
    } else if (computeEAR(results.faceLandmarks[0], "left") < 0.2 ||
               computeEAR(results.faceLandmarks[0], "right") < 0.2) {
      wetReason = "blink";
    } else {
      let prepared;
      try {
        const inputResult = matrixLayout === "corrected" ? { ...results, facialTransformationMatrixes:
          results.facialTransformationMatrixes.map(matrix => ({
            ...matrix, data: Array.from({ length: 16 }, (_, i) => matrix.data[(i % 4) * 4 + Math.floor(i / 4)]),
          })),
        } : results;
        prepared = wet.prepareInput(context.getImageData(0, 0, width, height), inputResult);
      } catch {
        wetReason = "eye_or_pose_preparation_failed";
      }
      wetPrepMs = now() - afterLandmarks;
      if (prepared) {
        const [patch, head, face] = prepared;
        if ([...head, ...face].every(Number.isFinite)) {
          const inferenceStart = now();
          const tensor = tf.tidy(() => blaze.predict(
            tf.browser.fromPixels(patch).toFloat().expandDims(0).div(255),
            tf.tensor2d([head]), tf.tensor2d([face]),
          ));
          try {
            const prediction = await tensor.data();
            if (prediction.length === 2 && prediction.every(Number.isFinite)) {
              const values = Array.from(prediction);
              if (adaptation?.applied) {
                const transform = wet.affineMatrix.arraySync();
                observation = gazeFeatures(transform.map(([a, b, c]) => a * values[0] + b * values[1] + c + 0.5));
              } else {
                observation = gazeFeatures(values.map(value => value + 0.5));
              }
              const target = fitTargets?.find(row => frame.timestamp >= row.start && frame.timestamp < row.end);
              if (target) {
                const offset = Math.abs(frame.timestamp - (target.start + target.end) / 2);
                if (offset < (supports.get(target.id)?.offset ?? Infinity)) {
                  supports.set(target.id, { offset, target, patch, head, face });
                }
              }
              geometryValues = [...head, ...face];
              wet.latestGazeResult = { faceOrigin3D: face };
            } else wetReason = "invalid_network_output";
          } finally {
            tensor.dispose();
          }
          networkMs = now() - inferenceStart;
        } else wetReason = "invalid_pose";
      }
    }
  }

  const beforePost = now();
  const point = adapter(frame.timestamp, variant === "mp" ? mp.features : observation);
  const ended = now();
  return {
    time: frame.timestamp, mp: mp.features ?? null, mpReason: mp.reason ?? null,
    wet: observation, wetReason, faces: raw.faces, pose: geometryValues, point, adaptation,
    prepareMs: beforeLandmarks - started, landmarkMs: afterLandmarks - beforeLandmarks,
    extraPrepareMs: wetPrepMs, modelMs: networkMs, postMs: ended - beforePost,
    started, ended,
  };
}

self.onmessage = async ({ data }) => {
  const { id, frame } = data;
  try {
    const result = frame ? await step(frame) : await start(data.config);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  } finally {
    frame?.close();
  }
};
