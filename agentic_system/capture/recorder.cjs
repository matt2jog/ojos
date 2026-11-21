const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const FRAME_US = 67_000;
const RETAIN_US = 60_000_000;
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_JOB_BYTES = 32 * 1024 * 1024;
const GAZE_STEP_US = 200_000;
const MAX_GAZE_GAP_US = 100_000;
const uint = value => Number.isSafeInteger(value) && value >= 0;

class Recorder {
  constructor({ maxBytes = MAX_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.stop();
  }

  stop() {
    this.sessionId = null;
    this.epoch = 0;
    this.geometry = null;
    this.frames = [];
    this.gaze = [];
    this.audio = [];
    this.bytes = 0;
  }

  start(captureEpoch = 0) {
    this.stop();
    this.epoch = captureEpoch;
    this.sessionId = randomUUID();
    return this.sessionId;
  }

  addFrame({ sessionId, timeUs, width, height, sourceWidth = width, sourceHeight = height, jpeg }) {
    if (!this.sessionId || sessionId !== this.sessionId) return;
    if (!uint(timeUs) || timeUs % 1000 || !uint(sourceWidth) || !uint(sourceHeight) ||
        !Number.isInteger(width) || width < 2 || width > 1920 || width % 2 ||
        !Number.isInteger(height) || height < 2 || height > 1080 || height % 2 ||
        !(jpeg instanceof Uint8Array) || jpeg.length < 2 || jpeg.length > 2 * 1024 * 1024 ||
        jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new Error('Invalid capture frame.');
    }
    const last = this.frames.at(-1);
    if (last && timeUs <= last.timeUs) return;
    if (this.geometry && (this.geometry.width !== width || this.geometry.height !== height ||
        this.geometry.sourceWidth !== sourceWidth || this.geometry.sourceHeight !== sourceHeight)) {
      this.frames = [];
      this.gaze = [];
      this.audio = [];
      this.bytes = 0;
      this.epoch++;
    }
    this.geometry = { width, height, sourceWidth, sourceHeight };
    this.frames.push({ timeUs, jpeg: Buffer.from(jpeg) });
    this.bytes += jpeg.length;
    while (this.frames.length && (this.bytes > this.maxBytes || timeUs - this.frames[0].timeUs >= RETAIN_US)) {
      this.bytes -= this.frames.shift().jpeg.length;
    }
    const oldest = this.frames[0]?.timeUs ?? timeUs;
    while (this.gaze.length && this.gaze[0].time_us < oldest - MAX_GAZE_GAP_US) this.gaze.shift();
    return { captureEpoch: this.epoch, width, height };
  }

  addAudio({ sessionId, timeUs, pcm }) {
    if (!this.sessionId || sessionId !== this.sessionId || !Number.isSafeInteger(timeUs) ||
        !(pcm instanceof ArrayBuffer) || pcm.byteLength !== 19_200 ||
        timeUs <= (this.audio.at(-1)?.timeUs ?? -Infinity)) return;
    this.audio.push({ timeUs, pcm: Buffer.from(new Uint8Array(pcm)) });
    const oldest = Math.max(this.frames[0]?.timeUs ?? 0, timeUs - RETAIN_US);
    while (this.audio.length > 1200 || this.audio[0]?.timeUs + 50_000 <= oldest) this.audio.shift();
  }

  addGaze(sample) {
    if (sample.type !== 'gaze.sample' || sample.schema_version !== 1 ||
        !this.geometry || !this.matches(sample) || !uint(sample.time_us) ||
        typeof sample.valid !== 'boolean' ||
        sample.time_us <= (this.gaze.at(-1)?.time_us ?? -1)) return;
    const { time_us, x_px, y_px, uncertainty_radius_px } = sample;
    const valid = sample.valid && [x_px, y_px, uncertainty_radius_px].every(Number.isFinite) &&
      x_px >= 0 && x_px < this.geometry.width && y_px >= 0 && y_px < this.geometry.height &&
      uncertainty_radius_px >= 0;
    this.gaze.push(valid ? { time_us, x_px, y_px, uncertainty_radius_px, valid } : { time_us, valid });
    if (this.gaze.length > 3600) this.gaze.shift();
  }

  matches(event) {
    return this.sessionId && event.session_id === this.sessionId && event.capture_epoch === this.epoch;
  }

  manual(nowUs) {
    return this.select(Math.max(0, nowUs - 20_000_000), nowUs, 'manual', randomUUID());
  }

  interval(event, nowUs) {
    if (event.type !== 'interval.finalized' || event.schema_version !== 1 || !this.matches(event) ||
        !uint(event.start_us) || !uint(event.end_us) || event.end_us <= event.start_us ||
        !['live', 'replay'].includes(event.source) || typeof event.event_id !== 'string' ||
        !event.event_id) throw new Error('Invalid or stale vision interval.');
    if (nowUs < event.end_us + 1_000_000) throw new Error('Waiting for post-roll.');
    return this.select(event.start_us, event.end_us, event.source, event.event_id);
  }

  select(eventStart, eventEnd, source, eventId) {
    if (this.frames.length === 0) throw new Error('No screen frames are available yet.');
    const automatic = source !== 'manual';
    const wantedStart = Math.max(0, eventStart - (automatic ? 10_000_000 : 0));
    const wantedEnd = eventEnd + (automatic ? 1_000_000 : 0);
    const end = Math.floor(Math.min(wantedEnd, this.frames.at(-1).timeUs + FRAME_US) / 1000) * 1000;
    let first = this.frames.findLastIndex(frame => frame.timeUs <= wantedStart);
    first = Math.max(0, first);
    // After a gap, start at the first frame that actually covers the requested media.
    if (wantedStart - this.frames[first].timeUs > FRAME_US) first++;
    const frames = this.frames.slice(first).filter(frame => frame.timeUs < end);
    const start = frames[0]?.timeUs;
    if (!frames.length || end <= start || Math.max(start, eventStart) >= Math.min(end, eventEnd) ||
        !frames.some(frame => frame.timeUs < eventEnd && frame.timeUs + FRAME_US > eventStart)) {
      throw new Error('Screen history does not cover the requested interval.');
    }
    const samples = this.clipGaze(frames, start, end);
    const audio = this.audio.filter(block => block.timeUs < end && block.timeUs + 50_000 > start);
    return {
      frames,
      audio,
      gaze: { schema_version: 1, samples },
      manifest: {
        schema_version: 1, session_id: this.sessionId, capture_epoch: this.epoch,
        event_id: eventId, source, event_start_us: source === 'manual' ? Math.max(eventStart, start) : eventStart,
        event_end_us: source === 'manual' ? end : eventEnd,
        clip_start_us: start, clip_end_us: end,
        viewport_width_px: this.geometry.width, viewport_height_px: this.geometry.height,
        audio_status: audio.length ? 'present' : 'unavailable', gaze_status: samples.length ? 'available' : 'unavailable'
      }
    };
  }

  clipGaze(frames, start, end) {
    let frame = 0;
    let next = 0;
    const samples = [];
    for (let time = start; time < end; time += GAZE_STEP_US) {
      while (next < this.gaze.length && this.gaze[next].time_us < time) next++;
      while (frames[frame + 1]?.timeUs <= time) frame++;
      const after = this.gaze[next];
      const before = after?.time_us === time ? after : this.gaze[next - 1];
      const valid = time - frames[frame].timeUs <= 2 * FRAME_US &&
        Boolean(before?.valid && after?.valid && after.time_us - before.time_us < MAX_GAZE_GAP_US);
      const fraction = valid && before !== after ? (time - before.time_us) / (after.time_us - before.time_us) : 0;
      const value = key => valid ? before[key] + fraction * (after[key] - before[key]) : null;
      samples.push({
        time_us: time - start, x_px: value('x_px'), y_px: value('y_px'),
        uncertainty_radius_px: value('uncertainty_radius_px'), valid
      });
    }
    return samples.some(sample => sample.valid) ? samples : [];
  }
}

async function writeBundle({ frames, audio = [], manifest, gaze }, parent, { signal } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ojos-frames-'));
  let output;
  try {
    output = await fs.mkdtemp(path.join(parent, 'ojos-'));
    const list = ['ffconcat version 1.0'];
    const end = manifest.clip_end_us;
    const lastDurationMs = (end - frames.at(-1).timeUs) / 1000;
    for (const [index, frame] of frames.entries()) {
      signal?.throwIfAborted();
      const name = `frame-${index}.jpg`;
      await fs.writeFile(path.join(scratch, name), frame.jpeg);
      const nextUs = frames[index + 1]?.timeUs ?? end;
      list.push(`file ${name}`, 'option framerate 1000', `duration ${((nextUs - frame.timeUs) / 1e6).toFixed(6)}`);
    }
    await fs.writeFile(path.join(scratch, 'clip.ffconcat'), list.join('\n') + '\n');
    const video = path.join(output, 'video.mp4');
    const audioInput = [];
    const audioOutput = ['-an'];
    if (audio.length) {
      const sampleBytes = 8; // stereo float32
      const toFrames = us => Math.round(us * 48_000 / 1e6);
      const pcm = Buffer.alloc(toFrames(end - manifest.clip_start_us) * sampleBytes);
      for (const block of audio) {
        const offset = toFrames(block.timeUs - manifest.clip_start_us) * sampleBytes;
        if (offset < pcm.length) block.pcm.copy(pcm, Math.max(0, offset), Math.max(0, -offset));
      }
      await fs.writeFile(path.join(scratch, 'playback.f32'), pcm);
      audioInput.push('-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'playback.f32');
      audioOutput.splice(0, 1, '-c:a', 'aac', '-b:a', '128k');
    }
    await run('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'clip.ffconcat',
      ...audioInput, ...audioOutput, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '8M',
      '-bufsize', '8M', '-pix_fmt', 'yuv420p', '-level:v', '4.1', '-bf', '0', '-enc_time_base', '1:1000',
      // Extend the last encoded sample to the actual clip boundary.
      '-bsf:v', `setts=duration='if(eq(N,${frames.length - 1}),${lastDurationMs},DURATION)'`,
      '-fps_mode', 'vfr', '-video_track_timescale', '1000', '-movflags', '+faststart', video
    ], { cwd: scratch, windowsHide: true, timeout: 60_000, signal });
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,start_time,duration',
      '-of', 'json', video
    ], { windowsHide: true, timeout: 10_000, signal });
    const [stream] = JSON.parse(stdout).streams;
    const durationUs = Number(stream?.duration) * 1e6;
    if (stream?.codec_name !== 'h264' || stream.width !== manifest.viewport_width_px ||
        stream.height !== manifest.viewport_height_px || Number(stream.start_time) !== 0 ||
        !Number.isFinite(durationUs) || Math.abs(durationUs - (end - manifest.clip_start_us)) > 1000) {
      throw new Error('Exported video timing or geometry differs from its manifest.');
    }
    const json = [manifest, gaze].map(value => JSON.stringify(value, null, 2) + '\n');
    if ((await fs.stat(video)).size + json.reduce((sum, value) => sum + Buffer.byteLength(value), 0) >= MAX_JOB_BYTES - 4096) {
      throw new Error('Export is too large for the v1 job limit.');
    }
    await fs.writeFile(path.join(output, 'manifest.json'), json[0]);
    await fs.writeFile(path.join(output, 'gaze.json'), json[1]);
    return output;
  } catch (error) {
    if (output) await fs.rm(output, { recursive: true, force: true });
    if (error.code === 'ENOENT') throw new Error('Install FFmpeg and FFprobe and make them available on PATH.');
    throw error;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function extractFrame(input, timeSeconds, output) {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) throw new Error('Provide clip-relative seconds.');
  const video = path.resolve(input);
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=duration:frame=best_effort_timestamp_time', '-of', 'json', video
  ], { windowsHide: true, timeout: 15_000 });
  const { frames, streams } = JSON.parse(stdout);
  if (!(timeSeconds < Number(streams[0]?.duration))) throw new Error('Timestamp is outside the clip.');
  const frame = frames.findLast(entry => Number(entry.best_effort_timestamp_time) <= timeSeconds);
  if (!frame) throw new Error('No frame covers that timestamp.');
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-n', '-ss', frame.best_effort_timestamp_time,
    '-i', video, '-frames:v', '1', path.resolve(output)
  ], { windowsHide: true, timeout: 15_000 });
  return Number(frame.best_effort_timestamp_time);
}

module.exports = { Recorder, writeBundle, extractFrame };
if (require.main === module) {
  const [input, seconds, output] = process.argv.slice(2);
  if (!input || !seconds || !output) {
    console.error('Usage: node recorder.cjs <video.mp4> <clip seconds> <frame.png>');
    process.exitCode = 1;
  } else {
    extractFrame(input, Number(seconds), output)
      .then(timestamp => console.log(`Extracted frame at clip time ${timestamp} s.`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
