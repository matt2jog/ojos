// The frontend supplies a dedicated Worker loaded from the bundled, local asset directory.
export function connectWebEyeTrack(worker, {geometry, sessionId, captureEpoch, assetsBaseUrl}) {
  let id = 0;
  let closed = false;
  const pending = new Map();
  const fail = error => {
    if (!closed) worker.terminate();
    closed = true;
    for (const {reject} of pending.values()) reject(error);
    pending.clear();
  };
  worker.onmessage = ({data}) => {
    const reply = pending.get(data.id);
    if (!reply) return;
    pending.delete(data.id);
    if (data.error) reply.reject(new Error(data.error));
    else reply.resolve(data.result);
  };
  worker.onerror = error => fail(new Error(error.message));
  worker.onmessageerror = () => fail(new Error("WebEyeTrack response could not be decoded"));

  function request(message, transfer = []) {
    if (closed) return Promise.reject(new Error("WebEyeTrack worker is closed"));
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(requestId, {resolve, reject});
      try {
        worker.postMessage({id: requestId, ...message}, transfer);
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  const ready = request({config: {
    variant: "wet", backend: "wasm", tfThreads: globalThis.crossOriginIsolated ? 2 : 1,
    matrixLayout: "stock", landmarkDelegate: "CPU",
    dimensions: [1280, 720], geometry, sessionId, captureEpoch, assetsBaseUrl,
  }}).catch(error => { fail(error); throw error; });

  return {
    ready,
    async send({frame, timeUs}) {
      await ready;
      // Browser capture may give VideoFrames timestamps on its own clock.
      const stamped = new VideoFrame(frame, {timestamp: timeUs});
      try {
        return await request({frame: stamped}, [stamped]);
      } finally {
        stamped.close();
      }
    },
    close() { fail(new Error("WebEyeTrack worker closed")); },
  };
}
