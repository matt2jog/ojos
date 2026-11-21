import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Use in the Electron main process or run directly against a bundle directory.
export async function analyzeBundle({manifest, gaze, video, token, baseUrl = 'http://127.0.0.1:8766',
                                     signal = AbortSignal.timeout(120_000)}) {
  if (!token) throw new Error('Set OJOS_LOCAL_TOKEN to the same token as the server');
  const headers = {Authorization: `Bearer ${token}`};
  const form = new FormData();
  form.set('manifest', JSON.stringify(manifest));
  form.set('gaze', JSON.stringify(gaze));
  form.set('video', new Blob([video], {type: 'video/mp4'}), 'video.mp4');

  const uploaded = await fetch(new URL('/v1/jobs', baseUrl), {method: 'POST', headers, body: form, signal});
  if (uploaded.status !== 202) throw new Error(`Upload returned HTTP ${uploaded.status}: ${await uploaded.text()}`);
  const {job_id: jobId} = await uploaded.json();
  const jobUrl = new URL(`/v1/jobs/${encodeURIComponent(jobId)}`, baseUrl);
  try {
    const stream = await fetch(`${jobUrl}/events`, {headers, signal});
    if (!stream.ok) throw new Error(`Job stream returned HTTP ${stream.status}: ${await stream.text()}`);

    // The MVP sends one complete analysis and closes the stream at the terminal event.
    let analysis;
    for (const record of (await stream.text()).split('\n\n')) {
      const lines = record.split('\n');
      const event = lines.find(line => line.startsWith('event: '))?.slice(7);
      if (!event) continue;
      const data = JSON.parse(lines.find(line => line.startsWith('data: ')).slice(6));
      if (event === 'job.analysis') analysis = data;
      if (event === 'job.result' && analysis) return {job_id: jobId, ...analysis};
      if (['job.error', 'job.canceled', 'job.expired'].includes(event)) {
        throw new Error(`${event}: ${data.message ?? data.reason ?? jobId}`);
      }
    }
    throw new Error(`Job ${jobId} closed without a complete MVP analysis`);
  } catch (error) {
    if (signal.aborted) {
      await fetch(jobUrl, {method: 'DELETE', headers, signal: AbortSignal.timeout(2_000)}).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [folder, baseUrl] = process.argv.slice(2);
  try {
    if (!folder) throw new Error('Usage: node agentic_system/assistant/desktop-client.mjs <bundle-folder> [base-url]');
    const [manifest, gaze, video] = await Promise.all([
      readFile(join(folder, 'manifest.json'), 'utf8').then(JSON.parse),
      readFile(join(folder, 'gaze.json'), 'utf8').then(JSON.parse),
      readFile(join(folder, 'video.mp4')),
    ]);
    console.log(JSON.stringify(await analyzeBundle({manifest, gaze, video, baseUrl, token: process.env.OJOS_LOCAL_TOKEN}), null, 2));
  } catch (error) {
    console.error(`Ojos desktop client: ${error.message}`);
    process.exitCode = 1;
  }
}
