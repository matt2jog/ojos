import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const upstream = process.argv[2] && path.resolve(process.argv[2]);
const revision = "75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c";
if (!upstream || execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== revision) {
  throw new Error("Pass a clean WebEyeTrack checkout at " + revision);
}
const assets = [
  ["docs/public/web/model.json", "web/model.json", "a214f074ccd4724cf4ebf008814a05485e7eaa5faf5aaeb85e66b24a1af55688"],
  ["docs/public/web/group1-shard1of1.bin", "web/group1-shard1of1.bin", "c030a762a2d21ac0f3c59700a723b2d8790f2003b3f8e72fbe31129fcb234e58"],
  ["python/webeyetrack/model_weights/face_landmarker_v2_with_blendshapes.task", "face_landmarker.task", "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"],
];
await mkdir("dist/web", { recursive: true });
await mkdir("dist/tf", { recursive: true });
for (const [file, destination, hash] of assets) {
  const source = path.join(upstream, file);
  if (createHash("sha256").update(await readFile(source)).digest("hex") !== hash) {
    throw new Error("Asset hash mismatch: " + file);
  }
  await copyFile(source, path.join("dist", destination));
}
await copyFile(path.join(upstream, "LICENSE"), "dist/WebEyeTrack-LICENSE");
await cp("node_modules/@mediapipe/tasks-vision/wasm", "dist/mp", { recursive: true });
for (const suffix of ["wasm", "simd.wasm", "threaded-simd.wasm"]) {
  const name = suffix === "wasm" ? "tfjs-backend-wasm.wasm" : "tfjs-backend-wasm-" + suffix;
  await copyFile(path.join("node_modules/@tensorflow/tfjs-backend-wasm/dist", name), path.join("dist/tf", name));
}
await build({
  entryPoints: ["bench-worker.mjs"], outfile: "dist/bench-worker.js",
  bundle: true, format: "iife", platform: "browser", target: "chrome128",
  alias: { "webeyetrack-source": path.join(upstream, "js/src") },
  nodePaths: [path.resolve("node_modules")],
  legalComments: "eof", define: { "process.env.NODE_ENV": '"production"' },
});
