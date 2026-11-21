const display = document.getElementById('display');
const startButton = document.getElementById('start');
const exportButton = document.getElementById('export');
const stopButton = document.getElementById('stop');
const status = document.getElementById('status');
const localUs = () => Math.round(performance.now() * 1000);
let active;
let ready = false;
let busy = false;
let exporting = false;

function controls() {
  startButton.disabled = !ready || busy || !!active;
  stopButton.disabled = !active?.track;
  exportButton.disabled = !active?.hasFrame || exporting;
  display.disabled = busy || !!active;
}

async function clockOffset() {
  let best = { rtt: Infinity };
  for (let sample = 0; sample < 5; sample++) {
    const before = localUs();
    const remote = await window.capture.clock();
    const after = localUs();
    if (after - before < best.rtt) best = { rtt: after - before, offset: remote - (before + after) / 2 };
  }
  return best.offset;
}

async function stop(current, message) {
  if (active !== current) return;
  active = null;
  current.track?.stop();
  current.reader?.cancel().catch(() => {});
  await window.capture.stop(current.sessionId);
  status.textContent = message;
  controls();
}

async function readFrames(current, offset) {
  const reader = new MediaStreamTrackProcessor({ track: current.track, maxBufferSize: 1 }).readable.getReader();
  current.reader = reader;
  let firstPts;
  let firstTime;
  let lastTime = -Infinity;
  let canvas;
  while (active === current) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    let width;
    let height;
    let timeUs;
    const sourceWidth = frame.displayWidth;
    const sourceHeight = frame.displayHeight;
    try {
      if (firstPts === undefined) {
        firstPts = frame.timestamp;
        firstTime = localUs() + offset - current.sessionStart;
      }
      timeUs = Math.max(0, Math.round((firstTime + frame.timestamp - firstPts) / 1000) * 1000);
      if (timeUs < lastTime - 1_000_000) throw new Error('The display clock reset. Start a new capture.');
      if (timeUs - lastTime < 64_000) continue;

      const scale = Math.min(1, 1920 / sourceWidth, 1080 / sourceHeight);
      width = Math.max(2, 2 * Math.floor(sourceWidth * scale / 2));
      height = Math.max(2, 2 * Math.floor(sourceHeight * scale / 2));
      if (!canvas || width !== canvas.width || height !== canvas.height) canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(frame, 0, 0, width, height);
    } finally {
      frame.close();
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.80 });
    if (active !== current) break;
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const geometry = await window.capture.frame({ sessionId: current.sessionId, timeUs, width, height, sourceWidth, sourceHeight, jpeg });
    if (active !== current) break;
    lastTime = timeUs;
    if (geometry && !current.hasFrame) {
      current.hasFrame = true;
      status.textContent = 'Recording.';
      controls();
    }
  }
  if (active === current) await stop(current, 'Screen sharing ended.');
}

startButton.addEventListener('click', async () => {
  busy = true;
  status.textContent = 'Waiting for screen sharing…';
  controls();
  let current;
  try {
    if (typeof MediaStreamTrackProcessor !== 'function') throw new Error('This Electron build lacks frame capture support.');
    const offset = await clockOffset();
    current = await window.capture.start(display.value);
    active = current;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 15, max: 15 } },
      audio: false, monitorTypeSurfaces: 'include', surfaceSwitching: 'exclude'
    });
    current.track = stream.getVideoTracks()[0];
    if (!current.track) throw new Error('The OS did not provide a display stream.');
    const surface = current.track.getSettings().displaySurface;
    if (surface && surface !== 'monitor') throw new Error('Select an entire display to record.');
    if (active !== current) {
      current.track.stop();
      return;
    }
    current.track.addEventListener('ended', () => stop(current, 'Screen sharing ended.'), { once: true });
    controls();
    await readFrames(current, offset);
  } catch (error) {
    const message = error.name === 'NotAllowedError' ? 'Screen sharing was canceled or denied.' : error.message;
    if (current) await stop(current, message);
    else status.textContent = message;
  } finally {
    busy = false;
    controls();
  }
});

stopButton.addEventListener('click', () => active && stop(active, 'Capture stopped. Buffer cleared.'));
window.capture.onInterrupt(message => active && stop(active, message));

exportButton.addEventListener('click', async () => {
  const current = active;
  exporting = true;
  status.textContent = 'Exporting clip…';
  controls();
  try {
    const folder = await window.capture.export(current.sessionId);
    if (active === current) status.textContent = folder ? `Clip saved in ${folder}` : 'Recording.';
  } catch (error) {
    if (active === current) status.textContent = `Export failed. ${error.message}`;
  } finally {
    exporting = false;
    controls();
  }
});

window.capture.sources().then(({ portal, displays }) => {
  document.getElementById('display-picker').hidden = portal;
  for (const source of displays) display.add(new Option(source.name, source.id));
  ready = portal || displays.length > 0;
  status.textContent = ready ? 'Ready to record.' : 'No displays are available for capture.';
  controls();
}).catch(error => { status.textContent = error.message; });
