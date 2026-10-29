import nspell from "nspell";

// The spelling rules shared by the worker and the tests: what counts as a word
// worth checking, how a Hunspell answer is softened for real writing (names
// with 's, curly apostrophes), and how suggestions are ranked.

export type Speller = ReturnType<typeof nspell>;

export function createSpeller(aff: string | Uint8Array, dic: string | Uint8Array): Speller {
  return nspell(aff, dic);
}

/** Curly apostrophes are how most people type, but the dictionaries use straight ones. */
export function plainWord(word: string): string {
  return word.replace(/[‘’ʼ]/g, "'");
}

/** Whether a token is checked at all. Acronyms, words with digits and mixed-case names (iPhone) aren't. */
export function checkable(word: string): boolean {
  if (word.length < 2 || /[\d_]/.test(word)) return false;
  if (word === word.toUpperCase()) return false;
  return !/\p{Lu}/u.test(word.slice(1));
}

export function isCorrect(speller: Speller, raw: string): boolean {
  const word = plainWord(raw);
  if (speller.correct(word)) return true;
  // Possessives and plurals of names: Kev's, the Smiths'.
  if (/'s$/i.test(word) && speller.correct(word.slice(0, -2))) return true;
  if (word.endsWith("'") && speller.correct(word.slice(0, -1))) return true;
  // A capital at the start of a sentence.
  const lower = word.charAt(0).toLowerCase() + word.slice(1);
  return lower !== word && speller.correct(lower);
}

/** Up to `limit` suggestions, closest first, in the same case as the word. */
export function suggestions(speller: Speller, raw: string, limit = 5): string[] {
  const word = plainWord(raw);
  const lower = word.toLowerCase();
  const capital = word.charAt(0) !== word.charAt(0).toLowerCase();
  const seen = new Set<string>();
  const ranked = speller
    .suggest(word)
    // An acronym is rarely what someone meant by a lower-case word.
    .filter((s) => capital || s !== s.toUpperCase() || s.length < 2)
    .map((s, i) => ({ s, i, d: distance(lower, s.toLowerCase()), near: slip(lower, s.toLowerCase()) }))
    // Ties go to a likely slip of the finger (teh -> the, notez -> notes), then Hunspell's order.
    .sort((a, b) => a.d - b.d || a.near - b.near || a.i - b.i)
    .map(({ s }) => (capital && s.charAt(0) === s.charAt(0).toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .filter((s) => !seen.has(s) && seen.add(s));
  return ranked.slice(0, limit);
}

const KEYBOARD = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** Next to each other on a QWERTY keyboard. */
function neighbours(a: string, b: string): boolean {
  const at = (c: string) => KEYBOARD.findIndex((row) => row.includes(c));
  const [ra, rb] = [at(a), at(b)];
  if (ra < 0 || rb < 0 || Math.abs(ra - rb) > 1) return false;
  return Math.abs(KEYBOARD[ra].indexOf(a) - KEYBOARD[rb].indexOf(b)) <= 1;
}

/** How likely `a` is a slip for `b`: 0 for two letters swapped, 1 for the key next door, 2 for neither. */
function slip(a: string, b: string): number {
  if (a.length !== b.length) return 2;
  if ([...a].sort().join("") === [...b].sort().join("")) return 0;
  const diff = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));
  return diff.length === 1 && neighbours(a[diff[0]], b[diff[0]]) ? 1 : 2;
}

/** Damerau-Levenshtein distance (with adjacent swaps, so "teh" is 1 from "the"). */
export function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
