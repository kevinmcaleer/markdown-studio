// The 3D scene eval: runs every case in evals/cases/ and scores it.
//
//   npm run eval            score every case; fail if one scores below its baseline
//   npm run eval:update     the same, then save today's scores as the new baseline
//
// The scorecard is printed, and written to evals/out/report.md (and .json).
// See evals/README.md for what a case is and how to add one.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GRADERS } from "./lib/graders";
import { caseScore, type Check } from "./lib/score";

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = join(here, "cases");
const baselineFile = join(here, "baseline.json");
const outDir = join(here, "out");
const updating = !!process.env.EVAL_UPDATE;

interface Case {
  title: string;
  /** Why the expected answer is the right one. */
  why?: string;
  input: unknown;
  expect: unknown;
  /** The score a new case must reach before it has a baseline (default 1). */
  pass?: number;
}

interface Result {
  id: string;
  kind: string;
  title: string;
  score: number;
  baseline: number | null;
  checks: Check[];
  error?: string;
}

const read = (path: string) => {
  const b = readFileSync(join(here, path));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const baseline: Record<string, number> = JSON.parse(readFileSync(baselineFile, "utf8"));
const kinds = readdirSync(casesDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name in GRADERS).map(d => d.name).sort();
const results: Result[] = [];
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

for (const kind of kinds) {
  describe(kind, () => {
    for (const file of readdirSync(join(casesDir, kind)).filter(f => f.endsWith(".json")).sort()) {
      const id = `${kind}/${basename(file, ".json")}`;
      const c: Case = JSON.parse(readFileSync(join(casesDir, kind, file), "utf8"));
      it(`${id}: ${c.title}`, () => {
        let checks: Check[];
        let error: string | undefined;
        try {
          checks = GRADERS[kind](c.input, c.expect, { read });
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          checks = [{ name: "runs", score: 0, detail: error }];
        }
        const score = Math.round(caseScore(checks) * 1000) / 1000;
        const was = id in baseline ? baseline[id] : null;
        results.push({ id, kind, title: c.title, score, baseline: was, checks, error });
        if (updating) return;
        const need = was ?? c.pass ?? 1;
        const why = checks.filter(k => k.score < 1).map(k => `  ${k.name}: ${k.detail}`).join("\n");
        expect(score, `${id} scored ${pct(score)}, below ${was === null ? "its pass mark" : "its baseline"} ${pct(need)}\n${why}`).toBeGreaterThanOrEqual(need - 0.0005);
      });
    }
  });
}

afterAll(() => {
  results.sort((a, b) => a.id.localeCompare(b.id));
  const mean = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
  const lines = [
    `# 3D scene eval`,
    ``,
    `**Overall: ${pct(mean)}** across ${results.length} cases.`,
    ``,
    `| Case | Score | Baseline | Change |`,
    `| --- | ---: | ---: | --- |`,
    ...results.map(r => {
      const change = r.baseline === null ? "new" : r.score > r.baseline + 0.0005 ? "better" : r.score < r.baseline - 0.0005 ? "**worse**" : "";
      return `| ${r.id}: ${r.title} | ${pct(r.score)} | ${r.baseline === null ? "–" : pct(r.baseline)} | ${change} |`;
    }),
  ];
  const misses = results.filter(r => r.score < 1);
  if (misses.length) {
    lines.push(``, `## Checks that lost marks`, ``);
    for (const r of misses) for (const k of r.checks.filter(k => k.score < 1)) lines.push(`- **${r.id}** · ${k.name} (${pct(k.score)}): ${k.detail}`);
  }
  const better = results.filter(r => r.baseline !== null && r.score > r.baseline + 0.0005);
  if (better.length && !updating) lines.push(``, `${better.length} case(s) improved. Run \`npm run eval:update\` to keep the new scores as the baseline.`);
  const report = lines.join("\n") + "\n";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.md"), report);
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ mean, results }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, report, { flag: "a" });
  if (updating) {
    const next = Object.fromEntries(results.map(r => [r.id, r.score]));
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + "\n");
  }
  console.log("\n" + report);
});
