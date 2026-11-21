import {readFile} from "node:fs/promises";
import {exportVisionSeries} from "./series.mjs";

const fixture = process.argv[2];
if (!fixture) throw new Error("Usage: node models/vision/replay.mjs <vision-history.json>");
const history = JSON.parse(await readFile(fixture, "utf8"));
process.stdout.write(JSON.stringify(exportVisionSeries(history), null, 2) + "\n");
