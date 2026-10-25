// A few grammar checks that need no server, for when LanguageTool isn't set
// up (or can't be reached). They're deliberately cautious: each catches a slip
// that is almost always wrong. Style and readability belong to the writing lint.

export type Issue = {
  /** Offsets in the text that was checked. */
  from: number;
  to: number;
  message: string;
  replacements: string[];
  rule: string;
};

// Doubled on purpose often enough that flagging them would nag.
const REPEAT_OK = new Set(["had", "that", "can", "do", "bye", "no", "very", "so", "ha", "la"]);

// Spelled with a vowel but said with a consonant (a university), and the reverse (an hour).
const SOUNDS_CONSONANT = /^(uni(?![nm])|use|usu|uti|ure|uro|ura|eu|ewe|one\b|once|ouija|ufo|uk\b|us\b)/;
const SOUNDS_VOWEL = /^(hour|honest|honou?r|heir)/;

/** Checks plain prose (no Markdown) and returns what looks wrong. */
export function basicGrammar(text: string): Issue[] {
  const issues: Issue[] = [];

  const tokens = [...text.matchAll(/\p{L}+/gu)];
  for (let i = 1; i < tokens.length; i++) {
    const [prev, word] = [tokens[i - 1], tokens[i]];
    const from = prev.index + prev[0].length;
    const gap = text.slice(from, word.index);
    if (word[0].toLowerCase() !== prev[0].toLowerCase() || REPEAT_OK.has(word[0].toLowerCase())) continue;
    if (!/^[ \t]*\n?[ \t]*$/.test(gap) || !gap) continue;
    issues.push({ from, to: word.index + word[0].length, message: `“${word[0]}” is repeated.`, replacements: [""], rule: "REPEATED_WORD" });
  }

  // A capital "A" only counts at the start of a sentence, so "plan A is" passes.
  for (const m of text.matchAll(/(?<=^|[\s(“"])(a|an|(?<=(?:^|[.!?]\s+))(?:A|An))\s+(\p{L}+)/gu)) {
    const [, article, next] = m;
    // Acronyms (an FBI agent) and names follow how they're said, which we can't tell.
    if (next === next.toUpperCase() || /^\p{Lu}/u.test(next)) continue;
    const word = next.toLowerCase();
    const vowel = SOUNDS_VOWEL.test(word) || (/^[aeiou]/.test(word) && !SOUNDS_CONSONANT.test(word));
    const wantsAn = vowel;
    const isAn = article.length === 2;
    if (wantsAn === isAn) continue;
    const fixed = isAn ? article.slice(0, 1) : `${article}n`;
    issues.push({
      from: m.index,
      to: m.index + article.length,
      message: wantsAn ? `Use “an” before a vowel sound: “an ${next}”.` : `Use “a” before a consonant sound: “a ${next}”.`,
      replacements: [fixed],
      rule: "A_AN",
    });
  }

  for (const m of text.matchAll(/(^|[\s(“"])(i)(?=$|[\s,;:!?)’'”"]|\.(?!e\.))/g)) {
    const from = m.index + m[1].length;
    issues.push({ from, to: from + 1, message: "“I” is always a capital.", replacements: ["I"], rule: "LOWERCASE_I" });
  }

  return issues.sort((a, b) => a.from - b.from);
}
