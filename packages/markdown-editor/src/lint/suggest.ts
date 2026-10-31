// Better wording for the writing hints, worked out locally from small word
// lists: an adverb and its verb become one stronger verb ("ran quickly" →
// "sprinted"), a wordy phrase becomes a short one ("in order to" → "to"), and
// any adverb can simply go. Every suggestion is an ordinary fix, so nothing
// changes until the writer clicks it.

export type Fix = { label: string; from: number; to: number; insert: string };

// ------------------------------------------------------------------ verbs

type Forms = { base: string; s: string; ed: string; ing: string };
type Form = keyof Forms;

/** Regular forms of a verb; "grab|grabs|grabbed|grabbing" spells out the awkward ones. */
function forms(spec: string): Forms {
  const parts = spec.split("|");
  if (parts.length === 4) return { base: parts[0], s: parts[1], ed: parts[2], ing: parts[3] };
  const base = parts[0];
  const consY = /[^aeiou]y$/.test(base);
  const s = consY ? base.slice(0, -1) + "ies" : /(?:s|sh|ch|x|z|o)$/.test(base) ? base + "es" : base + "s";
  const ed = consY ? base.slice(0, -1) + "ied" : base.endsWith("e") ? base + "d" : base + "ed";
  const ing = /[^e]e$/.test(base) ? base.slice(0, -1) + "ing" : base + "ing";
  return { base, s, ed, ing };
}

/** adverb → (verb → stronger verb). Verbs are given as `forms()` specs. */
const PAIRS: Record<string, [string, string][]> = {
  quickly: [["run|runs|ran|running", "sprint"], ["walk", "hurry"], ["move", "dash"], ["go|goes|went|going", "hurry"], ["look", "glance"], ["eat|eats|ate|eating", "gobble"], ["read|reads|read|reading", "skim"], ["write|writes|wrote|writing", "scribble"], ["drink|drinks|drank|drinking", "gulp"], ["leave|leaves|left|leaving", "rush off|rushes off|rushed off|rushing off"]],
  slowly: [["walk", "amble"], ["move", "creep|creeps|crept|creeping"], ["drink|drinks|drank|drinking", "sip|sips|sipped|sipping"], ["eat|eats|ate|eating", "nibble"], ["go|goes|went|going", "crawl"]],
  loudly: [["say|says|said|saying", "shout"], ["talk", "shout"], ["shut|shuts|shut|shutting", "slam|slams|slammed|slamming"], ["close", "slam|slams|slammed|slamming"], ["cry|cries|cried|crying", "wail"], ["laugh", "roar"]],
  quietly: [["say|says|said|saying", "whisper"], ["talk", "murmur"], ["walk", "tiptoe|tiptoes|tiptoed|tiptoeing"], ["laugh", "chuckle"]],
  carefully: [["look", "examine"], ["read|reads|read|reading", "study"], ["check", "inspect"], ["think|thinks|thought|thinking", "consider"]],
  closely: [["look", "examine"], ["watch", "study"], ["check", "inspect"]],
  briefly: [["look", "glance"], ["say|says|said|saying", "mention"], ["talk", "chat|chats|chatted|chatting"]],
  really: [["like", "love"], ["want", "crave"], ["hate", "loathe"], ["enjoy", "love"], ["need", "crave"]],
  badly: [["want", "crave"], ["need", "crave"]],
  strongly: [["recommend", "urge"], ["suggest", "urge"], ["disagree", "object"], ["believe", "insist"]],
  gently: [["push", "nudge"], ["hit|hits|hit|hitting", "tap|taps|tapped|tapping"], ["touch", "brush"], ["pull", "ease"]],
  tightly: [["hold|holds|held|holding", "grip|grips|gripped|gripping"]],
  firmly: [["hold|holds|held|holding", "grip|grips|gripped|gripping"], ["say|says|said|saying", "insist"]],
  angrily: [["say|says|said|saying", "snap|snaps|snapped|snapping"], ["look", "glare"], ["shut|shuts|shut|shutting", "slam|slams|slammed|slamming"]],
  happily: [["smile", "beam"], ["say|says|said|saying", "beam"]],
  sadly: [["say|says|said|saying", "sigh"], ["look", "mope"]],
  heavily: [["breathe", "pant"], ["walk", "trudge"], ["rain", "pour"]],
  lightly: [["touch", "brush"], ["hit|hits|hit|hitting", "tap|taps|tapped|tapping"], ["cook", "sauté|sautés|sautéed|sautéing"]],
  suddenly: [["stop|stops|stopped|stopping", "halt"], ["move", "lurch"], ["leave|leaves|left|leaving", "bolt"]],
  roughly: [["push", "shove"], ["cut|cuts|cut|cutting", "hack"]],
  completely: [["destroy", "demolish"], ["fill", "pack"], ["stop|stops|stopped|stopping", "halt"]],
  thoroughly: [["check", "inspect"], ["clean", "scrub|scrubs|scrubbed|scrubbing"], ["read|reads|read|reading", "study"]],
};

/** Adverbs that rarely carry meaning: the suggestion is to drop them. */
const FILLERS = new Set(
  "actually basically literally really totally completely absolutely definitely certainly extremely simply truly utterly seriously honestly obviously clearly incredibly genuinely".split(" "),
);

type VerbHit = { form: Form; to: string };
const VERBS = new Map<string, Map<string, VerbHit>>();
for (const [adverb, pairs] of Object.entries(PAIRS)) {
  const byForm = new Map<string, VerbHit>();
  for (const [verb, better] of pairs) {
    const v = forms(verb);
    const b = forms(better);
    for (const form of ["base", "s", "ed", "ing"] as Form[]) if (!byForm.has(v[form])) byForm.set(v[form], { form, to: b[form] });
  }
  VERBS.set(adverb, byForm);
}

// ------------------------------------------------------------------ case

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const matchCase = (original: string, replacement: string) => (/^\p{Lu}/u.test(original) ? capitalise(replacement) : replacement);

/** Whether `pos` is the first word of a sentence in `text`. */
function startsSentence(text: string, pos: number): boolean {
  const before = text.slice(0, pos).replace(/[\s>*_"“'‘(\[-]+$/u, "");
  return !before || /[.!?…:]$/.test(before) || /\n\s*$/.test(text.slice(0, pos));
}

// ------------------------------------------------------------------ fixes

/**
 * Takes the word at `from..to` out of `text` (offsets are the document's,
 * `text` starts at `base`), with the space beside it and a comma that only
 * propped it up, and capitalises the next word when it starts the sentence.
 */
export function removeWord(text: string, base: number, from: number, to: number): Fix {
  const word = text.slice(from - base, to - base);
  let a = from - base;
  let b = to - base;
  const after = /^,?[ \t]+/.exec(text.slice(b));
  if (after) b += after[0].length;
  else {
    // At the end of a sentence: take the space before it instead.
    const before = /[ \t]+$/.exec(text.slice(0, a));
    if (before) a -= before[0].length;
  }
  let insert = "";
  const next = /^\p{Ll}/u.exec(text.slice(b));
  if (next && /^\p{Lu}/u.test(word) && startsSentence(text, a)) {
    insert = next[0].toUpperCase();
    b += 1;
  }
  return { label: `Remove “${word}”`, from: base + a, to: base + b, insert };
}

const WORD_BEFORE = /(\p{L}+)(\s+)$/u;
const WORD_AFTER = /^(\s+)(\p{L}+)/u;

/** One-click fixes for an adverb: a stronger verb when it sits beside one we know, then removing it. */
export function adverbFixes(text: string, base: number, from: number, to: number): { fixes: Fix[]; message?: string } {
  const word = text.slice(from - base, to - base);
  const adverb = word.toLowerCase();
  const fixes: Fix[] = [];
  let message: string | undefined;
  const verbs = VERBS.get(adverb);
  if (verbs) {
    const prev = WORD_BEFORE.exec(text.slice(0, from - base));
    const next = WORD_AFTER.exec(text.slice(to - base));
    const hit =
      (prev && verbs.get(prev[1].toLowerCase()) && { start: from - prev[0].length, end: to, verb: prev[1], ...verbs.get(prev[1].toLowerCase())! }) ||
      (next && verbs.get(next[2].toLowerCase()) && { start: from, end: to + next[0].length, verb: next[2], ...verbs.get(next[2].toLowerCase())! }) ||
      null;
    if (hit) {
      const phrase = text.slice(hit.start - base, hit.end - base);
      const insert = matchCase(phrase, hit.to);
      fixes.push({ label: `Change to “${insert}”`, from: hit.start, to: hit.end, insert });
      message = `“${phrase}” could be one stronger verb: “${hit.to}”.`;
    }
  }
  if (!message && FILLERS.has(adverb)) message = `“${word}” rarely adds anything here. Try the sentence without it.`;
  fixes.push(removeWord(text, base, from, to));
  return { fixes, message };
}

// ------------------------------------------------------------------ wordy phrases

/** Wordy phrase → shorter one. Matched as whole words, any case. */
const WORDY: [string, string][] = [
  ["in order to", "to"],
  ["so as to", "to"],
  ["due to the fact that", "because"],
  ["owing to the fact that", "because"],
  ["in light of the fact that", "because"],
  ["despite the fact that", "although"],
  ["in spite of the fact that", "although"],
  ["at this point in time", "now"],
  ["at the present time", "now"],
  ["at this moment in time", "now"],
  ["in the near future", "soon"],
  ["in the event that", "if"],
  ["for the purpose of", "for"],
  ["with regard to", "about"],
  ["with regards to", "about"],
  ["in regard to", "about"],
  ["in relation to", "about"],
  ["in close proximity to", "near"],
  ["prior to", "before"],
  ["subsequent to", "after"],
  ["a large number of", "many"],
  ["a small number of", "a few"],
  ["the majority of", "most"],
  ["is able to", "can"],
  ["are able to", "can"],
  ["was able to", "could"],
  ["were able to", "could"],
  ["has the ability to", "can"],
  ["have the ability to", "can"],
  ["make use of", "use"],
  ["makes use of", "uses"],
  ["made use of", "used"],
  ["making use of", "using"],
  ["each and every", "every"],
  ["first and foremost", "first"],
  ["whether or not", "whether"],
  ["end result", "result"],
  ["past history", "history"],
  ["free gift", "gift"],
  ["join together", "join"],
  ["joined together", "joined"],
  ["advance planning", "planning"],
  ["basic fundamentals", "fundamentals"],
  ["unexpected surprise", "surprise"],
  ["very big", "huge"],
  ["very large", "huge"],
  ["very small", "tiny"],
  ["very good", "great"],
  ["very bad", "awful"],
  ["very important", "vital"],
  ["very tired", "exhausted"],
  ["very happy", "delighted"],
  ["very hot", "scorching"],
  ["very cold", "freezing"],
  ["very quick", "rapid"],
  ["very fast", "rapid"],
  ["very easy", "effortless"],
  ["very difficult", "tough"],
  ["very hungry", "starving"],
  ["very old", "ancient"],
  ["very scared", "terrified"],
  ["very angry", "furious"],
  ["very clear", "obvious"],
  ["very interesting", "fascinating"],
  ["very pretty", "beautiful"],
  ["very loud", "deafening"],
  ["very quiet", "silent"],
  ["very bright", "dazzling"],
  ["very strong", "powerful"],
  ["very weak", "feeble"],
  ["very sure", "certain"],
];

const WORDY_MAP = new Map(WORDY.map(([long, short]) => [long, short]));
// Longest first, so "in spite of the fact that" wins over shorter overlaps.
const WORDY_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...WORDY_MAP.keys()].sort((a, b) => b.length - a.length).map((p) => p.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "giu",
);

export type Wordy = { from: number; to: number; phrase: string; short: string; fix: Fix };

/** Wordy phrases in a paragraph's text, with the short form as a fix. */
export function wordyPhrases(text: string, base: number): Wordy[] {
  const out: Wordy[] = [];
  for (const m of text.matchAll(WORDY_RE)) {
    const phrase = m[0];
    const key = phrase.toLowerCase().replace(/\s+/g, " ");
    const short = WORDY_MAP.get(key);
    if (short === undefined) continue;
    const from = base + m.index!;
    const insert = matchCase(phrase, short);
    out.push({ from, to: from + phrase.length, phrase, short, fix: { label: `Change to “${insert}”`, from, to: from + phrase.length, insert } });
  }
  return out;
}
