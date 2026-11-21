import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const modelUrl = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const modelPath = process.env.OJOS_FACE_MODEL;
const output = fileURLToPath(new URL("../dist/", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.join(root, "node_modules", "@mediapipe", "tasks-vision");

const model = modelPath ? await readFile(modelPath) : await (async () => {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error("Face Landmarker download failed: " + response.status);
  return Buffer.from(await response.arrayBuffer());
})();
const digest = createHash("sha256").update(model).digest("hex");
if (digest !== MODEL_SHA256) throw new Error("Face Landmarker checksum mismatch: " + digest);

await mkdir(output, { recursive: true });
await writeFile(path.join(output, "face_landmarker.task"), model);
await cp(path.join(runtime, "wasm"), path.join(output, "wasm"), { recursive: true });
await copyFile(path.join(root, "third-party", "Apache-2.0.txt"), path.join(output, "Apache-2.0.txt"));
await copyFile(path.join(root, "third-party", "NOTICE.txt"), path.join(output, "NOTICE.txt"));

const host = path.join(output, "host");
await mkdir(host, { recursive: true });
for (const file of ["calibration.mjs", "features.mjs", "frame-queue.mjs", "timeline.mjs"]) {
  await copyFile(path.join(root, "src", file), path.join(host, file));
}

await build({
  entryPoints: [path.join(root, "src", "worker.mjs")],
  outfile: path.join(output, "gaze-worker.js"),
  bundle: true, format: "iife", platform: "browser", target: "chrome110",
  legalComments: "eof",
});
