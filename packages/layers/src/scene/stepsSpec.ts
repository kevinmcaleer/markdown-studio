// The build steps as saved in the project's model (see buildSteps.ts): kept
// apart, with no imports, so model.ts can read them without a loop.

export interface BuildStep {
  id: string;
  /** Its heading; left out, the names of its parts. */
  title?: string;
  /** The parts fitted in it, by id. A part is in one step at most. */
  parts: string[];
  /** A named view of the project's to draw it from, instead of the guide's own. */
  view?: string;
}

const MAX_STEPS = 500;

/** `value` as a list of steps: unknown fields dropped, each part in the first step that has it. */
export function normalizeSteps(value: unknown): BuildStep[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: BuildStep[] = [];
  for (const v of value.slice(0, MAX_STEPS)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Partial<BuildStep>;
    let id = typeof s.id === "string" && s.id && s.id.length <= 64 ? s.id : "";
    if (!id || ids.has(id)) id = newStepId(out);
    ids.add(id);
    const parts: string[] = [];
    for (const p of Array.isArray(s.parts) ? s.parts : []) {
      if (typeof p !== "string" || !p || seen.has(p)) continue;
      seen.add(p);
      parts.push(p);
    }
    const step: BuildStep = { id, parts };
    if (typeof s.title === "string" && s.title.trim()) step.title = s.title.trim().slice(0, 120);
    if (typeof s.view === "string" && s.view) step.view = s.view;
    out.push(step);
  }
  return out;
}

/** An id no step in `steps` has. */
export function newStepId(steps: Pick<BuildStep, "id">[]): string {
  let n = steps.length + 1;
  while (steps.some(s => s.id === `s${n}`)) n++;
  return `s${n}`;
}

/** The steps with parts no longer in the model, and views no longer saved, dropped. */
export function tidySteps(steps: BuildStep[], parts: { id: string }[], views?: { id: string }[]): BuildStep[] {
  const ids = new Set(parts.map(p => p.id));
  const named = new Set((views || []).map(v => v.id));
  return steps.map(s => {
    const out: BuildStep = { ...s, parts: s.parts.filter(id => ids.has(id)) };
    if (out.view && !named.has(out.view)) delete out.view;
    return out;
  });
}


/** The longest a tool typed in can be, and the most a guide lists. */
export const MAX_TOOL_LENGTH = 40;
export const MAX_GUIDE_TOOLS = 12;

/** Settings for the project's assembly guide. */
export interface GuideSettings {
  /**
   * What the Before you start page lists under You will need: a catalogue
   * tool's id (tools.ts), with its size after a colon ("allen-key:2.5 mm"),
   * or the name of any other tool, drawn as words. None set: the default
   * three.
   */
  tools?: string[];
}

/** `value` as guide settings (undefined when there's nothing set). */
export function normalizeGuide(value: unknown): GuideSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as GuideSettings).tools;
  if (!Array.isArray(raw)) return undefined;
  const tools: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const s = t.replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_LENGTH);
    if (s && !tools.some(x => x.toLowerCase() === s.toLowerCase())) tools.push(s);
    if (tools.length >= MAX_GUIDE_TOOLS) break;
  }
  return { tools };
}
