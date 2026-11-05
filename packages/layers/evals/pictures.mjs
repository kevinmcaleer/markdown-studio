// The picture half of the 3D scene eval. Each case in evals/cases/pictures/
// is a scene; it is drawn with the real renderer in a headless browser and
// compared, pixel by pixel,, with its approved picture in
// evals/pictures/approved/. The score is the share of line and tint pixels
// that match; a case passes at its "pass" mark (default 0.99).
//
//   npm run eval:pictures              draw and compare every case
//   npm run eval:pictures -- --approve draw them and keep these as the approved pictures
//   npm run eval:pictures -- leg       only the cases whose names contain "leg"
//
// What was drawn, and a picture of the differences (red), go to
// evals/out/pictures/ so you can see what changed.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, "cases", "pictures");
const approvedDir = join(here, "pictures", "approved");
const outDir = join(here, "out", "pictures");
const args = process.argv.slice(2);
const approving = args.includes("--approve");
const only = args.filter(a => !a.startsWith("--"));

const files = readdirSync(casesDir).filter(f => f.endsWith(".json") && (!only.length || only.some(o => f.includes(o)))).sort();
mkdirSync(outDir, { recursive: true });
mkdirSync(approvedDir, { recursive: true });

const server = await createServer({
  root: here,
  logLevel: "error",
  configFile: false,
  define: { __LAYERS_VERSION__: JSON.stringify("eval") },
  server: { port: 0, fs: { allow: [join(here, "..", "..", "..")] } },
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", e => console.error("page error:", e.message));
await page.goto(`${url}pictures/index.html`);
await page.waitForFunction(() => window.evalReady === true, null, { timeout: 60_000 });

const fromData = d => Buffer.from(d.split(",")[1], "base64");
const toData = b => `data:image/png;base64,${b.toString("base64")}`;
const rows = [];
let failed = 0;
for (const file of files) {
  const name = basename(file, ".json");
  const c = JSON.parse(readFileSync(join(casesDir, file), "utf8"));
  const got = await page.evaluate(c => window.evalRender(c), c);
  writeFileSync(join(outDir, `${name}.png`), fromData(got));
  const approved = join(approvedDir, `${name}.png`);
  if (approving) {
    writeFileSync(approved, fromData(got));
    rows.push({ name, title: c.title, score: 1, note: "approved" });
    continue;
  }
  if (!existsSync(approved)) {
    failed++;
    rows.push({ name, title: c.title, score: 0, note: "no approved picture yet (run with --approve)" });
    continue;
  }
  const r = await page.evaluate(([a, b]) => window.evalCompare(a, b), [got, toData(readFileSync(approved))]);
  writeFileSync(join(outDir, `${name}.diff.png`), fromData(r.diff));
  const pass = c.pass ?? 0.99;
  const ok = r.score >= pass;
  if (!ok) failed++;
  rows.push({ name, title: c.title, score: r.score, note: r.differ < 0 ? "a different size" : `${r.differ} of ${r.ink} line pixels differ${ok ? "" : ` (pass mark ${Math.round(pass * 1000) / 10}%)`}` });
}
await browser.close();
await server.close();

const pct = n => `${Math.round(n * 1000) / 10}%`;
const report = [
  `# 3D scene pictures`,
  ``,
  `| Picture | Score | |`,
  `| --- | ---: | --- |`,
  ...rows.map(r => `| ${r.name}: ${r.title} | ${pct(r.score)} | ${r.note} |`),
  ``,
  failed ? `**${failed} picture(s) changed.** See evals/out/pictures/ (red marks what moved). If the change is right, run \`npm run eval:pictures -- --approve\`.` : approving ? `Approved ${rows.length} picture(s).` : `Every picture matches.`,
].join("\n") + "\n";
writeFileSync(join(here, "out", "pictures.md"), report);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, report, { flag: "a" });
console.log(report);
process.exit(failed ? 1 : 0);
