export const EXPORT_STEP_US = 200_000;
export const MAX_GAP_US = 100_000;

export function invalidPoint(time_us) {
  return { time_us, x_px: null, y_px: null, uncertainty_radius_px: null, valid: false };
}

export function validPoint(time_us, [x_px, y_px], uncertainty_radius_px) {
  return { time_us, x_px, y_px, uncertainty_radius_px, valid: true };
}

export function gazeMessage(sessionId, epoch, point) {
  return { type: "gaze.sample", schema_version: 1, session_id: sessionId,
    capture_epoch: epoch, ...point };
}

export class GazeMedianFilter {
  #window = [];

  reset() {
    this.#window = [];
  }

  push(point) {
    if (!point.valid) {
      this.reset();
      return point;
    }
    const previous = this.#window.at(-1);
    if (previous && point.time_us - previous.time_us >= MAX_GAP_US) this.reset();
    this.#window.push(point);
    if (this.#window.length > 3) this.#window.shift();
    if (this.#window.length < 3) return point;
    const median = key => this.#window.map(sample => sample[key]).sort((a, b) => a - b)[1];
    return { ...point, x_px: median("x_px"), y_px: median("y_px") };
  }
}

// Input is the chronological worker ring, including neighbors of the clip if retained.
export function exportGaze(history, { sessionId, captureEpoch, clipStartUs, clipEndUs }) {
  if (![clipStartUs, clipEndUs].every(Number.isSafeInteger) ||
      clipStartUs < 0 || clipEndUs <= clipStartUs) throw new RangeError("Invalid clip range");

  const samplesForEpoch = history.filter(row =>
    row.session_id === sessionId && row.capture_epoch === captureEpoch);
  if (samplesForEpoch.some((row, i) => !Number.isSafeInteger(row.time_us) || row.time_us < 0 ||
      (i > 0 && row.time_us <= samplesForEpoch[i - 1].time_us))) {
    throw new RangeError("Expected increasing session gaze timestamps");
  }

  const samples = [];
  let right = 0;
  for (let relative = 0; relative < clipEndUs - clipStartUs; relative += EXPORT_STEP_US) {
    const time = clipStartUs + relative;
    while (right < samplesForEpoch.length && samplesForEpoch[right].time_us < time) right++;
    const after = samplesForEpoch[right];
    const before = samplesForEpoch[right - 1];
    if (after?.time_us === time && after.valid) {
      samples.push(validPoint(relative, [after.x_px, after.y_px], after.uncertainty_radius_px));
    } else if (before?.valid && after?.valid && after.time_us - before.time_us < MAX_GAP_US) {
      const fraction = (time - before.time_us) / (after.time_us - before.time_us);
      const lerp = key => before[key] + (after[key] - before[key]) * fraction;
      samples.push(validPoint(relative, [lerp("x_px"), lerp("y_px")],
        Math.max(before.uncertainty_radius_px, after.uncertainty_radius_px)));
    } else {
      samples.push(invalidPoint(relative));
    }
  }
  const available = samples.some(point => point.valid);
  return { gaze_status: available ? "available" : "unavailable",
    gaze: { schema_version: 1, samples: available ? samples : [] } };
}
