import { chromium } from "playwright";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const [data, configurationFile, output, browserName = "chrome"] = process.argv.slice(2);
if (!data || !configurationFile || !output) throw new Error("Usage: node browser.mjs LOCAL_PACKET_DIR PLAN_JSON OUTPUT_JSON [chrome|msedge]");
const configurations = JSON.parse(await (await import("node:fs/promises")).readFile(configurationFile, "utf8"));
const server = createServer(async (req, res) => {
  const route = new URL(req.url, "http://127.0.0.1").pathname;
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
  };
  if (route === "/") {
    res.writeHead(200, { ...headers, "Content-Type": "text/html" }).end('<!doctype html><script type="module" src="/runner.mjs"></script>');
    return;
  }
  let file;
  if (/^\/media\/(original|repeat)\/(index.json|packets.bin)$/.test(route)) {
    file = path.join(data, route.slice("/media/".length));
  } else if (/^\/dist\/[a-z0-9_.\/-]+$/i.test(route) && !route.includes("..") || route === "/runner.mjs") {
    file = path.join(process.cwd(), route.slice(1));
  }
  const type = { ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript",
    ".wasm": "application/wasm" }[path.extname(file ?? "")] ?? "application/octet-stream";
  try {
    const info = file && await stat(file);
    if (!info?.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": info.size });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: browserName, args: [
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--enable-unsafe-swiftshader",
  ] });
  const origin = "http://127.0.0.1:" + server.address().port;
  const results = [];
  for (const config of configurations) {
    const page = await browser.newPage();
    try {
      await page.route("**/*", route => route.request().url().startsWith(origin + "/")
        ? route.continue() : route.abort());
      await page.goto(origin);
      await page.waitForFunction(() => typeof window.run === "function");
      const result = await page.evaluate(config => window.run(config), {
        backend: "wasm", matrixLayout: "stock", fromUs: null, duration: null,
        paced: false, displayLoad: false, profile: null, ...config,
      });
      results.push({ config, ...result });
      console.log(config.id, JSON.stringify({ count: result.rows.length, wallMs: result.wallMs,
        dropped: result.dropped, backend: result.runtime.tfBackend, displayEncoded: result.displayEncoded }));
    } catch (error) {
      results.push({ config, error: String(error) });
      console.error(config.id, error.message);
    } finally {
      await page.close();
    }
    await writeFile(output, JSON.stringify({ browser: browser.version(), results }));
  }
  if (results.some(row => row.error)) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
