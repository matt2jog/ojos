#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setInterval as every } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const help = `Usage: node testing/preview-last-segment.mjs [--root PATH] [--path] [--no-open]
       node testing/preview-last-segment.mjs --watch [--no-open]

Open the last fully annotated replay in your browser. Use --path to print its file path.
--watch previews live automatic exports with confidence and gaze in a local browser tab.
Keep the command running while recording. Press Ctrl+C to stop. The preview never saves clips.`;

function open(target) {
  const windows = process.platform === 'win32';
  const literal = `'${target.replaceAll("'", "''")}'`;
  const script = `Start-Process ${literal}`;
  const executable = windows ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : [target];
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => console.error(`Open this location manually: ${target}`));
  child.unref();
}

async function json(folder, name) {
  return JSON.parse((await readFile(join(folder, name), 'utf8')).replace(/^\uFEFF/, ''));
}

async function findReplay(root) {
  const recordings = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory());
  const folders = [root, ...recordings.map(({ name }) => join(root, name, 'analysis', 'trigger-replay'))];
  let latest;
  for (const folder of folders) {
    try {
      const report = await json(folder, 'intervals.json');
      if (!Array.isArray(report.trigger_events)) continue;
      const saved = await stat(join(folder, 'intervals.json'));
      for (const { event, files } of report.trigger_events) {
        const video = files?.annotated;
        if (!Number.isFinite(event?.end_us) || !Number.isFinite(event.score) || typeof video !== 'string' ||
            basename(video) !== video || !/^interval-\d+-annotated\.mp4$/i.test(video)) continue;
        if (latest && (latest.savedAt > saved.mtimeMs ||
            (latest.savedAt === saved.mtimeMs && latest.event.end_us >= event.end_us))) continue;
        const path = join(folder, video);
        if ((await stat(path).catch(() => null))?.isFile()) latest = { path, event, savedAt: saved.mtimeMs };
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return latest;
}

async function startPreview(getClip, noOpen) {
  const page = await readFile(new URL('./segment-preview.html', import.meta.url));
  const prefix = `/${randomUUID()}/`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const data = getClip();
    if (request.method === 'GET' && url.pathname === prefix) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end(page);
    }
    if (request.method === 'GET' && url.pathname === `${prefix}clip`) {
      response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify(data?.metadata ?? null));
    }
    if (request.method === 'GET' && url.pathname === `${prefix}video` && data && url.searchParams.get('id') === data.metadata.id) {
      const length = data.video.length;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      response.setHeader('Content-Type', 'video/mp4');
      response.setHeader('Accept-Ranges', 'bytes');
      if (!range) {
        response.setHeader('Content-Length', length);
        return response.end(data.video);
      }
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), length - 1) : length - 1;
      if (start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${length}` });
        return response.end();
      }
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${length}`, 'Content-Length': end - start + 1 });
      return response.end(data.video.subarray(start, end + 1));
    }
    response.writeHead(404).end();
  });
  await new Promise((done, fail) => {
    server.once('error', fail).listen(0, '127.0.0.1', done);
  });
  const url = `http://127.0.0.1:${server.address().port}${prefix}`;
  console.log(url);
  if (!noOpen) open(url);
}

async function watchExports(noOpen) {
  let latest;
  let lastSavedAt = Date.now() - 120_000;
  await startPreview(() => latest, noOpen);
  console.log('Watching for a live automatic clip. Press Ctrl+C to stop.');
  const temp = tmpdir();
  for await (const _ of every(350)) {
    const paths = (await readdir(temp, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^ojos-[a-z0-9]{6}$/i.test(entry.name));
    for (const { name } of paths) {
      const folder = join(temp, name);
      try {
        // Ojos writes the gaze sidecar last, then removes this temporary bundle after analysis.
        const saved = await stat(join(folder, 'gaze.json'));
        if (saved.mtimeMs <= lastSavedAt || saved.size > 256 * 1024) continue;
        const manifest = await json(folder, 'manifest.json');
        if (manifest.schema_version !== 1 || manifest.source !== 'live') continue;
        const gaze = await json(folder, 'gaze.json');
        if (gaze.timebase !== 'clip_relative_us' || !Array.isArray(gaze.samples)) continue;
        const file = join(folder, 'video.mp4');
        const media = await stat(file);
        if (media.size < 12 || media.size > 32 * 1024 * 1024) continue;
        const video = await readFile(file);
        if (video.toString('ascii', 4, 8) !== 'ftyp') continue;
        latest = { video, metadata: { id: randomUUID(), manifest, gaze } };
        lastSavedAt = saved.mtimeMs;
        console.log('Live clip loaded in memory.');
      } catch (error) {
        // The clip can be finalized or removed while the watcher reads its files.
        if (!(error instanceof SyntaxError) && !['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      }
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, path: { type: 'boolean' }, watch: { type: 'boolean' },
    'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return console.log(help);
  if (values.watch) return watchExports(values['no-open']);
  const root = resolve(values.root ?? join(homedir(), 'Videos', 'Ojos test recordings'));
  const replay = await findReplay(root);
  if (!replay) throw new Error(`No annotated replay found under ${root}`);
  if (values.path) return console.log(replay.path);
  const clip = {
    video: await readFile(replay.path),
    metadata: { id: randomUUID(), replay: basename(replay.path), score: replay.event.score }
  };
  await startPreview(() => clip, values['no-open']);
  console.log(`Saved replay: ${clip.metadata.replay} · peak confusion ${clip.metadata.score.toFixed(2)}. Press Ctrl+C to stop.`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
