// Match the target layout in models/eye-tracking/src/calibration.mjs.
const fitPoints = [
  [0.5, 0.5], [0.12, 0.12], [0.88, 0.88], [0.88, 0.12], [0.12, 0.88],
  [0.5, 0.12], [0.12, 0.5], [0.88, 0.5], [0.5, 0.88],
];
const validationPoints = [
  [0.27, 0.27], [0.73, 0.73], [0.73, 0.27], [0.27, 0.73], [0.62, 0.51],
];

const settleMs = 250;
const collectMs = 500;
const holdMs = 1150;
const screen = document.querySelector('#calibration-screen');
const dot = document.querySelector('#calibration-dot');
const countdown = document.querySelector('#calibration-countdown');

function delay(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function nextFrame(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const frame = requestAnimationFrame((time) => {
      signal.removeEventListener('abort', cancel);
      resolve(time);
    });
    function cancel() {
      cancelAnimationFrame(frame);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function recordCalibration({ width, height }, timestamp, controller) {
  const { signal } = controller;
  const result = {
    schema_version: 1,
    started: timestamp(),
    viewport_width_px: width,
    viewport_height_px: height,
    targets: [],
  };
  const cancel = () => controller.abort();
  const onFullscreen = () => {
    if (document.fullscreenElement !== screen) cancel();
  };
  const onVisibility = () => {
    if (document.hidden) cancel();
  };

  screen.hidden = false;
  countdown.hidden = false;
  countdown.textContent = 'Keep your head still and look at each dot.';
  try {
    if (!(width > 0) || !(height > 0)) {
      throw new Error('The browser did not report the shared display size.');
    }
    await screen.requestFullscreen({ navigationUI: 'hide' });
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('visibilitychange', onVisibility);
    await nextFrame(signal);
    const bounds = screen.getBoundingClientRect();
    result.fullscreen_width_css_px = bounds.width;
    result.fullscreen_height_css_px = bounds.height;
    result.device_pixel_ratio = window.devicePixelRatio;
    if (Math.abs((bounds.width / bounds.height) / (width / height) - 1) > 0.02) {
      throw new Error('Move the recorder to the display you shared, then try calibration again.');
    }
    screen.focus({ preventScroll: true });

    await delay(2000, signal);
    countdown.hidden = true;
    for (const [kind, points] of [['fit', fitPoints], ['validation', validationPoints]]) {
      for (const [index, [x, y]] of points.entries()) {
        dot.style.left = `${x * 100}%`;
        dot.style.top = `${y * 100}%`;
        dot.hidden = false;
        await nextFrame(signal);
        const shownAt = await nextFrame(signal);
        const target = {
          id: `${kind}-${index + 1}`,
          kind,
          x_normalized: x,
          y_normalized: y,
          x_px: x * (width - 1),
          y_px: y * (height - 1),
          shown: timestamp(shownAt),
          collect_from: timestamp(shownAt + settleMs),
          collect_until: timestamp(shownAt + settleMs + collectMs),
        };
        result.targets.push(target);
        await delay(holdMs, signal);
        target.completed = true;
      }
    }
    result.status = 'complete';
  } catch (error) {
    result.status = signal.aborted ? 'canceled' : 'failed';
    if (result.status === 'failed') result.error = error.message;
  } finally {
    result.ended = timestamp();
    document.removeEventListener('fullscreenchange', onFullscreen);
    document.removeEventListener('visibilitychange', onVisibility);
    dot.hidden = true;
    screen.hidden = true;
    if (document.fullscreenElement === screen) {
      await document.exitFullscreen().catch(() => {});
    }
  }
  return result;
}
