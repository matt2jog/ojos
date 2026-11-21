// Clip-relative Gemini sidecar. Input histories use the capture session clock.
export const SERIES_VERSION = 2;
export const EXPORT_STEP_US = 200_000;
export const GAZE_MAX_AGE_US = 100_000;
const CONFUSION_MAX_AGE_US = 250_000;

export const GAZE_MODELS = Object.freeze({
  model1: "webeyetrack-blazegaze-75fbd2f-ridge-v1",
  model2: "eth-xgaze-resnet50-epoch24-camera-plane-ridge-v1",
});

const integer = value => Number.isSafeInteger(value) && value >= 0;
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

function scopeHistory(rows, sessionId, epoch) {
  const history = rows.filter(row => row.session_id === sessionId && row.capture_epoch === epoch);
  if (history.some((row, index) => !integer(row.time_us) ||
      (index > 0 && row.time_us <= history[index - 1].time_us))) {
    throw new RangeError("Vision history must have strictly increasing capture timestamps");
  }
  let right = 0;
  return time => {
    while (history[right]?.time_us <= time) right++;
    return [history[right - 1], history[right]];
  };
}

function nearGaze([before, after], time, width, height) {
  const beforeAge = before ? time - before.time_us : Infinity;
  const afterAge = after ? after.time_us - time : Infinity;
  const row = beforeAge <= afterAge ? before : after;
  // Choose the nearest observation before testing validity. A blink stays a gap.
  if (Math.min(beforeAge, afterAge) >= GAZE_MAX_AGE_US || !row?.valid) return null;
  if (![row.x_px, row.y_px, row.uncertainty_radius_px].every(Number.isFinite) ||
      row.x_px < 0 || row.x_px >= width || row.y_px < 0 || row.y_px >= height ||
      row.uncertainty_radius_px < 0) throw new RangeError("Invalid encoded gaze point");
  return row;
}

function bounds(points, width, height) {
  const min = (axis, limit) => Math.max(0, Math.min(limit,
    ...points.map(point => point[axis] - point.uncertainty_radius_px)));
  const max = (axis, limit) => Math.min(limit,
    Math.max(...points.map(point => point[axis] + point.uncertainty_radius_px)));
  const x = min("x_px", width);
  const y = min("y_px", height);
  return { x, y, w: max("x_px", width) - x, h: max("y_px", height) - y };
}

export function exportVisionSeries({sessionId, captureEpoch, clipStartUs, clipEndUs, width, height,
  model1 = [], model2 = [], confusion = [], confusionModel = null}) {
  if (typeof sessionId !== "string" || !sessionId ||
      ![captureEpoch, clipStartUs, clipEndUs, width, height].every(integer) ||
      clipEndUs <= clipStartUs || width === 0 || height === 0) {
    throw new RangeError("Invalid clip clock or encoded dimensions");
  }
  const firstAt = scopeHistory(model1, sessionId, captureEpoch);
  const secondAt = scopeHistory(model2, sessionId, captureEpoch);
  const scoreAt = scopeHistory(confusion, sessionId, captureEpoch);
  const samples = [];
  for (let offset = 0; offset < clipEndUs - clipStartUs; offset += EXPORT_STEP_US) {
    const time = clipStartUs + offset;
    const first = nearGaze(firstAt(time), time, width, height);
    const second = nearGaze(secondAt(time), time, width, height);
    const [candidate] = scoreAt(time);
    const score = candidate?.valid && time - candidate.time_us < CONFUSION_MAX_AGE_US ? candidate : null;
    if (score && ![score.confidence_raw, score.confidence].every(probability)) {
      throw new RangeError("Invalid confusion score");
    }
    const paired = first && second && Math.abs(first.time_us - second.time_us) < GAZE_MAX_AGE_US;
    const points = paired ? [first, second] : [first ?? second].filter(Boolean);
    const mean = axis => points.length ? points.reduce((sum, point) => sum + point[axis], 0) / points.length : null;
    samples.push({
      time_us: offset,
      confidence: score?.confidence ?? null,
      confidence_raw: score?.confidence_raw ?? null,
      confidence_offset_us: score ? score.time_us - time : null,
      x_model1: first?.x_px ?? null, y_model1: first?.y_px ?? null,
      x_model2: second?.x_px ?? null, y_model2: second?.y_px ?? null,
      uncertainty_model1_px: first?.uncertainty_radius_px ?? null,
      uncertainty_model2_px: second?.uncertainty_radius_px ?? null,
      model1_offset_us: first ? first.time_us - time : null,
      model2_offset_us: second ? second.time_us - time : null,
      average_x: mean("x_px"), average_y: mean("y_px"),
      maxbox: points.length ? bounds(points, width, height) : null,
      fusion_mode: paired ? "paired" : first ? "model1_only" : second ? "model2_only" : "unavailable",
    });
  }
  return {
    gaze_status: samples.some(row => row.maxbox) ? "available" : "unavailable",
    gaze: {schema_version: SERIES_VERSION, timebase: "clip_relative_us", step_us: EXPORT_STEP_US,
      viewport_width_px: width, viewport_height_px: height,
      models: {...GAZE_MODELS, confusion: confusionModel}, samples},
  };
}
