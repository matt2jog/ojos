import { createGazePipeline } from "./vision.mjs";

let generation = 0;
let pipeline = null;

// A host can use this entry point or call createGazePipeline from its own vision worker.
self.onmessage = async ({ data }) => {
  const { type, requestId } = data;
  const reply = payload => self.postMessage({ requestId, ...payload });
  if (type === "start") {
    const current = ++generation;
    pipeline?.close();
    pipeline = null;
    try {
      const next = await createGazePipeline(data.options);
      if (current !== generation) {
        next.close();
        reply({ type: "superseded" });
      } else {
        pipeline = next;
        reply({ type: "ready" });
      }
    } catch (error) {
      reply({ type: "error", message: String(error) });
    }
    return;
  }

  const { frame } = data;
  try {
    if (type === "close") {
      generation++;
      pipeline?.close();
      pipeline = null;
      reply({ type: "closed" });
      return;
    }
    if (!pipeline) throw new Error("Gaze worker has no active epoch");
    switch (type) {
      case "frame":
        reply({ type: "frame.done", output: pipeline.processFrame(frame, data.timeUs) });
        break;
      case "tracking.lost":
        reply({ type: "tracking.lost.done", output: pipeline.trackingLost(data.timeUs) });
        break;
      case "calibration":
        pipeline.setCalibration(data.calibration);
        reply({ type: "calibration.done" });
        break;
      case "stats":
        reply({ type: "stats.done", stats: pipeline.stats() });
        break;
      default: throw new Error("Unknown gaze worker request");
    }
  } catch (error) {
    reply({ type: "error", message: String(error) });
  } finally {
    frame?.close();
  }
};
