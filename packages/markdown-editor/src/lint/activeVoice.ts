// Turns a passive sentence that says who did it ("The code was written by Kev.")
// into the active voice ("Kev wrote the code.") with word lists and a few
// rules, in the browser, with no server. A sentence that doesn't say who did
// it has no doer to move to the front, so it gets no rewrite.

// participle → [past tense, base form]
const IRREGULAR: Record<string, [string, string]> = {
  awoken: ["awoke", "awake"], beaten: ["beat", "beat"], begun: ["began", "begin"], bent: ["bent", "bend"], bitten: ["bit", "bite"],
  blown: ["blew", "blow"], broken: ["broke", "break"], brought: ["brought", "bring"], built: ["built", "build"], burnt: ["burnt", "burn"],
  bought: ["bought", "buy"], caught: ["caught", "catch"], chosen: ["chose", "choose"], cut: ["cut", "cut"], dealt: ["dealt", "deal"],
  done: ["did", "do"], drawn: ["drew", "draw"], driven: ["drove", "drive"], eaten: ["ate", "eat"], fed: ["fed", "feed"], felt: ["felt", "feel"],
  fought: ["fought", "fight"], found: ["found", "find"], forbidden: ["forbade", "forbid"], forgotten: ["forgot", "forget"], forgiven: ["forgave", "forgive"],
  frozen: ["froze", "freeze"], given: ["gave", "give"], grown: ["grew", "grow"], hung: ["hung", "hang"], heard: ["heard", "hear"],
  hidden: ["hid", "hide"], hit: ["hit", "hit"], held: ["held", "hold"], hurt: ["hurt", "hurt"], kept: ["kept", "keep"], known: ["knew", "know"],
  laid: ["laid", "lay"], led: ["led", "lead"], left: ["left", "leave"], lent: ["lent", "lend"], let: ["let", "let"], lost: ["lost", "lose"],
  made: ["made", "make"], meant: ["meant", "mean"], met: ["met", "meet"], paid: ["paid", "pay"], put: ["put", "put"], read: ["read", "read"],
  ridden: ["rode", "ride"], rung: ["rang", "ring"], run: ["ran", "run"], said: ["said", "say"], seen: ["saw", "see"], sold: ["sold", "sell"],
  sent: ["sent", "send"], set: ["set", "set"], shaken: ["shook", "shake"], shot: ["shot", "shoot"], shown: ["showed", "show"], shut: ["shut", "shut"],
  sung: ["sang", "sing"], sunk: ["sank", "sink"], spoken: ["spoke", "speak"], spent: ["spent", "spend"], spun: ["spun", "spin"],
  spread: ["spread", "spread"], stolen: ["stole", "steal"], struck: ["struck", "strike"], sworn: ["swore", "swear"], swept: ["swept", "sweep"],
  taken: ["took", "take"], taught: ["taught", "teach"], torn: ["tore", "tear"], told: ["told", "tell"], thought: ["thought", "think"],
  thrown: ["threw", "throw"], understood: ["understood", "understand"], woken: ["woke", "wake"], worn: ["wore", "wear"], won: ["won", "win"],
  written: ["wrote", "write"], wound: ["wound", "wind"],
};

// -ed words whose base form the rules below would get wrong.
const BASE: Record<string, string> = {
  added: "add", developed: "develop", enveloped: "envelop", pivoted: "pivot", piloted: "pilot", visited: "visit", edited: "edit",
  limited: "limit", credited: "credit", exhibited: "exhibit", inhibited: "inhibit", profited: "profit", deposited: "deposit",
  audited: "audit", benefited: "benefit", controlled: "control", patrolled: "patrol", labelled: "label", modelled: "model",
  travelled: "travel", cancelled: "cancel", levelled: "level", fuelled: "fuel", signalled: "signal", tied: "tie", died: "die", lied: "lie",
  united: "unite", ignited: "ignite", recited: "recite", invited: "invite", excited: "excite", cited: "cite", explained: "explain",
};

/** The base form of a regular -ed participle: "stored" → "store", "stopped" → "stop", "tried" → "try". */
export function baseOf(participle: string): string {
  const w = participle.toLowerCase();
  if (IRREGULAR[w]) return IRREGULAR[w][1];
  if (BASE[w]) return BASE[w];
  if (!w.endsWith("ed")) return w;
  if (w.endsWith("ied")) return `${w.slice(0, -3)}y`;
  const stem = w.slice(0, -2);
  // stopped, planned, preferred: the last consonant was doubled.
  if (/[aeiou]([bdgmnprt])\1$/.test(stem)) return stem.slice(0, -1);
  if (stem.endsWith("ee")) return stem;
  if (/it$/.test(stem)) return stem;
  // stored, created, moved, placed, changed, handled: the base ends in a silent e.
  if (/(?:(?:^|[^aeiou])[aiou]|ea|ui)[^aeiouwxy]$/.test(stem) || /[vcuz]$/.test(stem) || /[nd]g$/.test(stem) || /[^aeiou]l$/.test(stem) || /[^aeiou]s$/.test(stem)) return `${stem}e`;
  return stem;
}

const pastOf = (participle: string) => IRREGULAR[participle.toLowerCase()]?.[0] ?? participle.toLowerCase();

function thirdPerson(base: string): string {
  if (base === "have") return "has";
  if (base === "be") return "is";
  if (/(?:s|x|z|ch|sh|o)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

const SUBJECT: Record<string, string> = { me: "I", us: "we", him: "he", her: "she", them: "they", whom: "who" };
const OBJECT: Record<string, string> = { i: "me", we: "us", he: "him", she: "her", they: "them", who: "whom" };
// Words that start a phrase in lower case once they're no longer first.
const LOWER = new Set(
  "the a an this that these those it its he she they we you my our your his her their some all each every any no one many most several another both either neither".split(" "),
);
const MODALS = new Set(["will", "would", "can", "could", "should", "shall", "may", "might", "must"]);

/** Whether the doer reads as plural ("you", "the team and I", "the motors") for is/are and has/have. */
function plural(agent: string): boolean {
  const a = agent.toLowerCase().trim();
  if (/^(?:i|we|you|they)$/.test(a) || /\band\b/.test(a)) return true;
  const last = /(\w+)\W*$/.exec(a)?.[1] ?? "";
  return /[^su]s$/.test(last) && !/(?:ss|is|us)$/.test(last);
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function asObject(phrase: string): string {
  const p = phrase.trim();
  const lower = p.toLowerCase();
  if (OBJECT[lower]) return OBJECT[lower];
  const first = /^\p{L}+/u.exec(p)?.[0] ?? "";
  return LOWER.has(first.toLowerCase()) ? p.charAt(0).toLowerCase() + p.slice(1) : p;
}

function asSubject(phrase: string): string {
  const p = phrase.trim();
  // "the team and me" → "the team and I"
  return SUBJECT[p.toLowerCase()] ?? p.replace(/\b(and|or)\s+me\b/gi, "$1 I").replace(/\bme\s+and\b/gi, "I and");
}

// Where the doer's name stops: a comma, a new clause or a place/time/tool phrase.
const AGENT_END =
  /(?:[,;:]|\s[—–-]\s|\s(?:in|on|at|with|for|from|to|using|during|after|before|because|when|while|so|and then|which|who|is|are|was|were|but)\s|[.!?…]*["'”’)\]]*$)/i;
// Where the done-to part starts: after the last clause opener before the verb.
const CLAUSE_START = /(?:^|[,;:]\s+|\s(?:that|which|because|when|while|if|so|but|and)\s+)/gi;

const BE = /^(am|is|are|was|were|be|been|isn't|aren't|wasn't|weren't)\s+(?:(not|never)\s+)?(?:(\p{L}+ly)\s+)?(\p{L}+)$/iu;

/**
 * The sentence in the active voice, or null when there's no clear doer ("… by X").
 * `phrase` is where the passive hint is in the sentence: [from, to) offsets.
 */
export function toActive(sentence: string, from: number, to: number): string | null {
  const m = BE.exec(sentence.slice(from, to));
  if (!m) return null;
  let [, be, negative, adverb, participle] = m;
  be = be.toLowerCase();
  const pl = participle.toLowerCase();
  if (!IRREGULAR[pl] && !pl.endsWith("ed")) return null;
  if (be.endsWith("n't")) {
    be = be.slice(0, -3);
    negative = "not";
  }

  // "has been", "will be": the word before belongs to the verb too.
  let verbStart = from;
  let aux = "";
  if (be === "been" || be === "be") {
    const before = /(\p{L}+)\s+$/u.exec(sentence.slice(0, from));
    if (!before) return null;
    aux = before[1].toLowerCase();
    if (be === "been" ? !["has", "have", "had"].includes(aux) : !MODALS.has(aux)) return null;
    verbStart = before.index;
  }

  // The doer: "by X", straight after the verb.
  // An adverb may sit between: "was presented badly by them" → "they presented it badly".
  const by = /^(?:\s+(\p{L}+ly))?\s+by\s+/iu.exec(sentence.slice(to));
  if (!by) return null;
  const afterBy = to + by[0].length;
  const end = AGENT_END.exec(sentence.slice(afterBy));
  const agentEnd = afterBy + (end ? end.index : sentence.length - afterBy);
  const agent = sentence.slice(afterBy, agentEnd).trim();
  if (!agent || agent.split(/\s+/).length > 8) return null;
  const tail = sentence.slice(agentEnd);

  // The done-to part: from the start of its clause to the verb.
  const head = sentence.slice(0, verbStart);
  let clause = 0;
  for (const c of head.matchAll(CLAUSE_START)) clause = c.index! + c[0].length;
  const prefix = head.slice(0, clause);
  const patient = head.slice(clause).trim();
  // "The code that was written by Kev": no done-to part in the clause, so none after the verb.
  const relative = !patient && /\b(?:that|which)\s+$/i.test(prefix);
  if (!patient && !relative) return null;

  const many = plural(agent);
  const base = baseOf(pl);
  const not = negative ? ` ${negative}` : "";
  const adv = adverb ? ` ${adverb}` : "";
  let verb: string;
  if (be === "been") verb = `${aux === "had" ? "had" : many ? "have" : "has"}${not}${adv} ${pl}`;
  else if (be === "be") verb = `${aux}${not}${adv} ${base}`;
  else if (be === "was" || be === "were") verb = negative ? `did ${negative}${adv} ${base}` : `${adverb ? `${adverb} ` : ""}${pastOf(pl)}`;
  else verb = negative ? `${many ? "do" : "does"} ${negative}${adv} ${base}` : `${adverb ? `${adverb} ` : ""}${many ? base : thirdPerson(base)}`;

  let subject = asSubject(agent);
  if (prefix && LOWER.has((/^\p{L}+/u.exec(subject)?.[0] ?? "").toLowerCase())) subject = subject.charAt(0).toLowerCase() + subject.slice(1);
  const object = (relative ? "" : ` ${asObject(patient)}`) + (by[1] ? ` ${by[1]}` : "");
  const clauseText = `${subject} ${verb}${object}`;
  const rewritten = prefix ? `${prefix}${clauseText}${tail}` : `${capitalise(clauseText)}${tail}`;
  return rewritten.replace(/\s{2,}/g, " ");
}
