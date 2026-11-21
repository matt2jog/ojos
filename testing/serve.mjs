import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2] ?? 8765);
const recordingFolder = resolve(process.argv[3] ?? join(homedir(), 'Videos', 'Ojos test recordings'));
const recordingFile = /^\/api\/recordings\/(ojos-[\w-]+)\/(screen-with-audio\.webm|webcam\.webm|capture\.json)$/;
const maxChunkBytes = 64 * 1024 * 1024;
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleRecordingRequest(request, response, url.pathname);
    } catch (error) {
      console.error(error.message);
      if (!response.destroyed) response.writeHead(500).end('Could not save the recording.');
    }
    return;
  }
  if (url.pathname === '/') {
    response.writeHead(302, { Location: '/recorder/' }).end();
    return;
  }
  const pathname = url.pathname;
  const file = resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
  const type = types.get(extname(file));
  if (request.method !== 'GET' || !type || !pathIsInside(file)) {
    response.writeHead(404).end();
    return;
  }

  try {
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});

async function handleRecordingRequest(request, response, pathname) {
  const host = request.headers.host;
  const localPort = request.socket.localPort;
  if (host !== `127.0.0.1:${localPort}` && host !== `localhost:${localPort}`) {
    response.writeHead(403).end();
    return;
  }
  if (request.method === 'GET' && pathname === '/api/recordings') {
    sendJson(response, { path: recordingFolder });
    return;
  }
  if (request.method !== 'POST' || request.headers.origin !== `http://${host}`) {
    response.writeHead(403).end();
    return;
  }
  if (pathname === '/api/recordings') {
    await mkdir(recordingFolder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = await mkdtemp(join(recordingFolder, `ojos-${stamp}-`));
    sendJson(response, { id: basename(path), path });
    return;
  }
  const match = recordingFile.exec(pathname);
  if (!match) {
    response.writeHead(404).end();
    return;
  }
  const length = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxChunkBytes) {
    response.writeHead(413).end('Recording buffer was too large or empty.');
    return;
  }
  const [, id, name] = match;
  const target = join(recordingFolder, id, name);
  const isManifest = name === 'capture.json';
  const pending = isManifest ? target + '.tmp' : target;
  const writer = createWriteStream(pending, { flags: isManifest ? 'w' : 'a' });
  await pipeline(request, writer);
  if (isManifest) await rename(pending, target);
  response.writeHead(204).end();
}

function sendJson(response, data) {
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(data));
}

function pathIsInside(file) {
  return file.startsWith(resolve(root) + sep);
}

server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Recorder: http://127.0.0.1:${port}/recorder/`);
  console.log(`Reasoning test: http://127.0.0.1:${port}/reasoning-test/`);
});
