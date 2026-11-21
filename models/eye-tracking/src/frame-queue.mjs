/**
 * Backpressure for an async worker transport. submit takes ownership of the frame;
 * send takes ownership of dispatched frames and settles on the worker response.
 */
export class LatestGazeFrames {
  #send;
  #onError;
  #pending = null;
  #busy = false;
  #closed = false;
  droppedFrames = 0;

  constructor(send, onError) {
    this.#send = send;
    this.#onError = onError;
  }

  submit(frame, timeUs) {
    if (this.#closed) {
      frame.close();
      return;
    }
    if (this.#pending) {
      this.#pending.frame.close();
      this.droppedFrames++;
    }
    this.#pending = { frame, timeUs };
    if (!this.#busy) void this.#drain();
  }

  close() {
    this.#closed = true;
    this.#pending?.frame.close();
    this.#pending = null;
  }

  async #drain() {
    this.#busy = true;
    while (this.#pending) {
      const { frame, timeUs } = this.#pending;
      this.#pending = null;
      try {
        await this.#send(frame, timeUs);
      } catch (error) {
        this.close();
        this.#onError(error);
      }
    }
    this.#busy = false;
  }
}
