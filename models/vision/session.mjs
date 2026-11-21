import {createGazeProjector} from "./calibration.mjs";
import {VisionFrameDispatcher} from "./dispatch.mjs";
import {exportVisionSeries, GAZE_MAX_AGE_US, GAZE_MODELS} from "./series.mjs";

// One instance per capture epoch. Its ring contains numerical outputs only.
export class VisionSession {
  #config;
  #geometry;
  #projectors;
  #history = {model1: [], model2: [], confusion: []};
  #dispatcher;

  constructor({sessionId, captureEpoch, geometry, profiles = {}, workers, clockUs,
    onInterval, onObservation, onError, confusionModel = null, rates}) {
    if (Object.keys(workers).some(key => key !== "confusion" && !Object.hasOwn(GAZE_MODELS, key))) {
      throw new TypeError("Unknown vision worker");
    }
    this.#config = {sessionId, captureEpoch, width: geometry.viewportWidth, height: geometry.viewportHeight, confusionModel};
    this.#geometry = geometry;
    this.updateProfiles(profiles);
    this.#dispatcher = new VisionFrameDispatcher({workers, clockUs, onError, rates, onResult: reply => {
      const {worker, timeUs, result} = reply;
      if (worker === "confusion") {
        if (!result) return;
        const {sample, interval} = result;
        if (sample.session_id !== sessionId || sample.capture_epoch !== captureEpoch || sample.time_us !== timeUs) {
          throw new Error("Confusion reply does not match its capture frame");
        }
        this.#config.confusionModel = sample.model_version;
        this.#history.confusion.push(sample);
        if (interval) onInterval?.(interval, timeUs);
      } else {
        this.#history[worker].push(this.#projectors[worker](timeUs, result));
        onObservation?.(worker, timeUs, result);
      }
    }});
  }

  updateProfiles(profiles) {
    const {sessionId, captureEpoch} = this.#config;
    this.#projectors = Object.fromEntries(Object.keys(GAZE_MODELS).map(tracker => [tracker,
      createGazeProjector({tracker, geometry: this.#geometry, profile: profiles[tracker], sessionId, captureEpoch})]));
  }

  submit(frame, timeUs, frameId) {
    this.#dispatcher.submit(frame, timeUs, frameId);
    const discardBefore = timeUs - 60_000_000 - GAZE_MAX_AGE_US;
    for (const rows of Object.values(this.#history)) {
      while (rows[0]?.time_us < discardBefore) rows.shift();
    }
  }

  exportClip(clipStartUs, clipEndUs) {
    return exportVisionSeries({...this.#config, ...this.#history, clipStartUs, clipEndUs});
  }

  stats() { return this.#dispatcher.stats(); }

  close() { this.#dispatcher.close(); }
}
