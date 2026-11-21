import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
const metrics = JSON.parse(await readFile(path.join(root, "metrics.json"), "utf8"));
const durations = Number(process.env.OJOS_PACE_SECONDS ?? 12);
function plan(kind, heights, rates, variants, overrides = {}) {
  return heights.flatMap(height => rates.flatMap(rate => variants.map(variant => {
    const candidate = metrics.accuracy["repeat-" + height][rate][variant === "mp" ? "mp" : "wetRidge"];
    if (!candidate?.model) throw new Error("No fit for " + [variant, height, rate]);
    return { id: [kind, variant, height, rate, overrides.backend ?? "wasm", overrides.tfThreads ?? 1, overrides.landmarkDelegate ?? "cpu"].join("-"),
      name: "original", height, rate, variant, windowName: "reasoning", paced: true, duration: durations,
      profile: candidate.model, profilePassed: candidate.passed, ...overrides };
  })));
}
const idle = plan("idle", [720, 480], [30, 20, 15, 10], ["mp", "wet"]);
const load = [
  ...plan("load", [720, 480], [20, 15, 10], ["mp", "wet"], { displayLoad: true }),
  ...plan("load", [720, 480], [20], ["wet"], { displayLoad: true, tfThreads: 2 }),
];
const backends = [
  ...plan("backend", [720, 480], [20], ["wet"], { backend: "wasm", tfThreads: 2 }),
  ...plan("backend", [720, 480], [20], ["wet"], { backend: "webgl", duration: durations + 8 }),
  ...plan("backend", [720], [20], ["wet"], { backend: "webgl", landmarkDelegate: "GPU", duration: durations + 8 }),
];
const confirm = [
  ...plan("check", [720, 480], [20], ["wet"], { displayLoad: true, duration: 24, tfThreads: 2 }),
  ...plan("check", [480], [20], ["wet"], { displayLoad: true, duration: 24 }),
];
for (const [name, rows] of [["pace", idle], ["load", load], ["backends", backends], ["load-check", confirm]]) {
  await writeFile(path.join(root, name + "-plan.json"), JSON.stringify(rows, null, 2) + "\n");
}
