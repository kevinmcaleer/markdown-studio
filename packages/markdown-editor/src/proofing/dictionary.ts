// Your own dictionary (words you've added, on this device) and the words and
// grammar spots you told it to ignore (until you reload). Both cover every
// note and language.

const KEY = "notes.dictionary";
const listeners = new Set<() => void>();
const ignored = new Set<string>();
let words: Set<string> = load();

function load(): Set<string> {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(list) ? list.filter((w) => typeof w === "string") : []);
  } catch {
    return new Set();
  }
}

function changed() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...words].sort()));
  } catch {
    /* private mode */
  }
  for (const listener of listeners) listener();
}

const key = (word: string) => word.replace(/[‘’]/g, "'");

/** How an ignored grammar spot is remembered: its rule and its text. */
export function issueKey(rule: string, text: string): string {
  return `\u0000${rule}\u0000${text}`;
}

export const personalDictionary = {
  has: (word: string) => words.has(key(word)) || ignored.has(key(word)),
  add(word: string) {
    words.add(key(word));
    changed();
  },
  ignore(word: string) {
    ignored.add(key(word));
    for (const listener of listeners) listener();
  },
  size: () => words.size,
  clear() {
    words = new Set();
    changed();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
