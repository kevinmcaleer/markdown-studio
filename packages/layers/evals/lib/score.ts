// How a case is scored. Every case runs a few *checks*; each check scores
// from 0 (wrong) to 1 (right), and the case's score is their average
// (weighted, when a check says it counts for more).
//
// A check on a number gives part marks: full marks within its tolerance,
// none at three times the tolerance or more, and a straight line between,
// so "a bit off" shows as a bit less than 1 rather than a plain fail.

export interface Check {
  name: string;
  score: number;
  /** What was found, against what was wanted, for the report. */
  detail: string;
  weight?: number;
}

/** Full marks within `tol` of right, none at `3 × tol`. */
export function closeness(error: number, tol: number): number {
  const e = Math.abs(error);
  if (!Number.isFinite(e)) return 0;
  if (e <= tol) return 1;
  if (e >= 3 * tol) return 0;
  return 1 - (e - tol) / (2 * tol);
}

const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(n));
export const show = (v: unknown): string => (Array.isArray(v) ? `[${v.map(x => (typeof x === "number" ? fmt(x) : show(x))).join(", ")}]` : typeof v === "number" ? fmt(v) : String(v));

/** A number close to what's wanted. */
export function near(name: string, got: number, want: number, tol: number, weight?: number): Check {
  return { name, score: closeness(got - want, tol), detail: `got ${show(got)}, want ${show(want)} ± ${show(tol)}`, weight };
}

/** A point close to where it's wanted (straight-line distance). */
export function nearPoint(name: string, got: number[], want: number[], tol: number, weight?: number): Check {
  const err = Math.hypot(...got.map((g, i) => g - want[i]));
  return { name, score: closeness(err, tol), detail: `got ${show(got)}, want ${show(want)} (off by ${show(err)})`, weight };
}

/** Exactly what's wanted, or nothing. */
export function same(name: string, got: unknown, want: unknown, weight?: number): Check {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  return { name, score: ok ? 1 : 0, detail: `got ${show(got)}, want ${show(want)}`, weight };
}

/** True or false. */
export function yes(name: string, ok: boolean, detail = "", weight?: number): Check {
  return { name, score: ok ? 1 : 0, detail: detail || (ok ? "yes" : "no"), weight };
}

/** At least `min`, with part marks below it, down to none at `min - slack`. */
export function atLeast(name: string, got: number, min: number, slack: number, weight?: number): Check {
  const score = got >= min ? 1 : Math.max(0, 1 - (min - got) / slack);
  return { name, score, detail: `got ${show(got)}, want at least ${show(min)}`, weight };
}

export function caseScore(checks: Check[]): number {
  const total = checks.reduce((s, c) => s + (c.weight ?? 1), 0);
  return total ? checks.reduce((s, c) => s + c.score * (c.weight ?? 1), 0) / total : 0;
}
