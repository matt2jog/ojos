const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { Recorder, writeBundle, extractFrame } = require('./recorder.cjs');
const run = promisify(execFile);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function add(recorder, timeUs, image = jpeg, width = 320) {
  recorder.addFrame({ sessionId: recorder.sessionId, timeUs, width, height: 180, jpeg: image });
}

function event(recorder) {
  return {
    type: 'interval.finalized', source: 'replay', schema_version: 1,
    session_id: recorder.sessionId, capture_epoch: recorder.epoch, event_id: 'd8731f55-4642-41ce-aeed-e0ca50283c54',
    start_us: 14_000_000, end_us: 18_000_000
  };
}

function gaze(recorder, time_us) {
  recorder.addGaze({
    type: 'gaze.sample', schema_version: 1, session_id: recorder.sessionId,
    capture_epoch: recorder.epoch, time_us, valid: true, x_px: 151, y_px: 64, uncertainty_radius_px: 12
  });
}

test('evicts old and oversized history and clears the buffer on stop', () => {
  const recorder = new Recorder({ maxBytes: jpeg.length * 2 });
  const sessionId = recorder.start();
  add(recorder, 0);
  add(recorder, 1_000);
  add(recorder, 60_000_000);
  add(recorder, 60_001_000);
  assert.deepEqual(recorder.frames.map(frame => frame.timeUs), [60_000_000, 60_001_000]);
  const clip = recorder.manual(60_010_000);
  assert.equal(clip.manifest.event_start_us, 60_000_000);
  assert.equal(clip.manifest.source, 'manual');
  assert.deepEqual(clip.gaze.samples, []);
  recorder.stop();
  assert.equal(recorder.addFrame({ sessionId, timeUs: 60_020_000, width: 320, height: 180, jpeg }), undefined);
  assert.throws(() => recorder.manual(60_020_000), /No screen frames/);
});

test('rejects stale epochs, early events and intervals wholly inside a screen gap', () => {
  const recorder = new Recorder();
  recorder.start();
  const interval = event(recorder);
  add(recorder, 4_000_000);
  add(recorder, 19_200_000);
  assert.throws(() => recorder.interval(interval, 18_900_000), /post-roll/);
  assert.throws(() => recorder.interval(interval, 19_200_000), /does not cover/);
  add(recorder, 19_267_000, jpeg, 640);
  assert.equal(recorder.epoch, 1);
  assert.throws(() => recorder.interval(interval, 19_300_000), /stale/);
  assert.equal(recorder.frames.length, 1);
});

test('exports an aligned MP4 from the delayed v1 replay and extracts the observed frame', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ojos-recorder-test-'));
  try {
    async function color(name) {
      const { stdout } = await run('ffmpeg', [
        '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${name}:size=320x180`,
        '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'
      ], { encoding: 'buffer', windowsHide: true });
      return stdout;
    }
    const [before, after] = await Promise.all([color('red'), color('blue')]);
    const recorder = new Recorder();
    recorder.start();
    for (let i = 60; i <= 288; i++) {
      const time = Math.round(i * 1000 / 15) * 1000;
      add(recorder, time, time === 9_400_000 ? before : after);
    }
    gaze(recorder, 9_400_000);
    const bundle = recorder.interval(event(recorder), 19_200_000);
    assert.equal(bundle.manifest.clip_start_us, 4_000_000);
    assert.equal(bundle.manifest.clip_end_us, 19_000_000);
    assert.equal(bundle.gaze.samples[27].time_us, 5_400_000);
    assert.equal(bundle.gaze.samples[27].x_px, 151);
    assert.equal(bundle.gaze.samples[28].valid, false);
    const output = await writeBundle(bundle, folder);
    const video = path.join(output, 'video.mp4');
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,duration', '-of', 'json', video
    ], { windowsHide: true });
    const { packets } = JSON.parse(stdout);
    assert.equal(packets.length, 225);
    assert.ok(packets.every((packet, i) => !i || packet.pts > packets[i - 1].pts));
    assert.equal(packets.at(-1).pts + packets.at(-1).duration, 15_000);
    const image = path.join(folder, 'observed.png');
    assert.equal(await extractFrame(video, 5.421, image), 5.4);
    const { stdout: pixel } = await run('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', image, '-vf', 'scale=1:1,format=rgb24',
      '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'
    ], { encoding: 'buffer', windowsHide: true });
    assert.ok(pixel[0] > 200 && pixel[2] < 40, 'expected the red frame shown at fixation');
    await assert.rejects(extractFrame(video, 15, image), /outside/);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'gaze.json'), 'utf8')).samples.length, 75);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});
