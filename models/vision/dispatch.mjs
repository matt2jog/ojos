// Capture timestamps and clockUs() use the same monotonic session clock.
export const DEMO_RATES = Object.freeze({model1: 15, model2: 5, confusion: 8});
export const REPLY_BUDGET_US = 150_000;

export class VisionFrameDispatcher {
  #lanes;
  #clockUs;
  #onResult;
  #onError;
  #origin = null;
  #lastTime = -1;
  #lastFrame = -1;
  #closed = false;

  constructor({workers, clockUs, onResult, onError, rates = DEMO_RATES}) {
    this.#clockUs = clockUs;
    this.#onResult = onResult;
    this.#onError = onError;
    this.#lanes = Object.entries(workers).map(([name, send]) => {
      const rate = rates[name];
      if (typeof send !== "function" || !Number.isFinite(rate) || rate <= 0 || rate > 60) {
        throw new TypeError(`Invalid worker configuration for ${name}`);
      }
      return {name, send, rate, slot: -1, busy: false, pending: null,
        offered: 0, dropped: 0, delivered: 0, late: 0, failed: 0};
    });
  }

  // The host owns the original frame. Each worker receives a clone for the duration of its request.
  submit(frame, timeUs, frameId) {
    if (this.#closed) return;
    if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs <= this.#lastTime ||
        !Number.isSafeInteger(frameId) || frameId < 0 || frameId <= this.#lastFrame) {
      throw new RangeError("Capture frame timestamps and IDs must increase within an epoch");
    }
    this.#origin ??= timeUs;
    this.#lastTime = timeUs;
    this.#lastFrame = frameId;
    for (const lane of this.#lanes) {
      const slot = Math.floor((timeUs - this.#origin) * lane.rate / 1e6);
      if (slot === lane.slot) continue;
      lane.slot = slot;
      lane.offered++;
      lane.dropped += Number(Boolean(lane.pending));
      lane.pending?.frame.close();
      lane.pending = {frame: frame.clone(), timeUs, frameId};
      if (!lane.busy) void this.#drain(lane);
    }
  }

  async #drain(lane) {
    lane.busy = true;
    try {
      while (lane.pending) {
        const packet = lane.pending;
        lane.pending = null;
        try {
          if (this.#clockUs() - packet.timeUs >= REPLY_BUDGET_US) {
            lane.dropped++;
            continue;
          }
          const result = await lane.send(packet);
          if (this.#closed) return;
          const ageUs = this.#clockUs() - packet.timeUs;
          const late = ageUs >= REPLY_BUDGET_US;
          if (late) lane.late++;
          else lane.delivered++;
          this.#onResult({worker: lane.name, timeUs: packet.timeUs, frameId: packet.frameId,
            ageUs, late, result: late && lane.name !== "confusion" ? null : result});
        } catch (error) {
          lane.failed++;
          if (!this.#closed) this.#onError?.(error, lane.name);
        } finally {
          packet.frame.close();
        }
      }
    } finally {
      lane.busy = false;
    }
  }

  stats() {
    return Object.fromEntries(this.#lanes.map(({name, rate, offered, dropped, delivered, late, failed}) =>
      [name, {rate, offered, dropped, delivered, late, failed}]));
  }

  close() {
    this.#closed = true;
    for (const lane of this.#lanes) {
      lane.pending?.frame.close();
      lane.pending = null;
    }
  }
}
