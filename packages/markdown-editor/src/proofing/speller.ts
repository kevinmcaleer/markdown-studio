// The main thread's side of spelling: remembers every word it has asked
// about, so scrolling back and forth never asks twice, and talks to the
// Hunspell worker for the rest.

import { dictionaryUrl } from "./dictionaryUrls";
import { startWorker } from "./startWorker";

export type ProofLanguage = "en-GB" | "en-US";

type SpellBody = { type: "check"; words: string[] } | { type: "suggest"; word: string };

/** `dic` is the word list's URL, absolute so a worker started from a blob can fetch it. */
export type SpellRequest = SpellBody & { id: number; language: ProofLanguage; dic: string };

export type SpellResponse = { id: number; wrong?: string[]; suggestions?: string[]; error?: string };

/** What the editor needs from a speller; the tests pass a fake one. */
export type SpellChecker = {
  /** True or false once known; undefined while it's still being asked. */
  known(word: string): boolean | undefined;
  /** Finds out about these words; resolves when they're all known. */
  check(words: string[]): Promise<void>;
  suggest(word: string): Promise<string[]>;
};

class WorkerSpeller implements SpellChecker {
  private results = new Map<string, boolean>();
  private suggested = new Map<string, Promise<string[]>>();
  private pending = new Map<number, (r: SpellResponse) => void>();
  private next = 1;
  private worker: Worker | null = null;
  private failed = false;

  constructor(private language: ProofLanguage) {}

  private send(request: SpellBody): Promise<SpellResponse> {
    if (this.failed) return Promise.resolve({ id: 0, error: "unavailable" });
    if (!this.worker) {
      try {
        this.worker = startWorker();
      } catch {
        this.failed = true;
        return Promise.resolve({ id: 0, error: "unavailable" });
      }
      this.worker.onmessage = (e: MessageEvent<SpellResponse>) => {
        this.pending.get(e.data.id)?.(e.data);
        this.pending.delete(e.data.id);
      };
      this.worker.onerror = () => {
        this.failed = true;
        for (const resolve of this.pending.values()) resolve({ id: 0, error: "unavailable" });
        this.pending.clear();
      };
    }
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker!.postMessage({ ...request, id, language: this.language, dic: dictionaryUrl(this.language) });
    });
  }

  known(word: string): boolean | undefined {
    return this.results.get(word);
  }

  async check(words: string[]): Promise<void> {
    const fresh = [...new Set(words)].filter((w) => !this.results.has(w));
    if (!fresh.length) return;
    const answer = await this.send({ type: "check", words: fresh });
    // If the dictionary can't load, treat everything as right rather than underline it all.
    const wrong = new Set(answer.error ? [] : answer.wrong);
    for (const w of fresh) this.results.set(w, !wrong.has(w));
  }

  suggest(word: string): Promise<string[]> {
    let found = this.suggested.get(word);
    if (!found) {
      found = this.send({ type: "suggest", word }).then((r) => r.suggestions ?? []);
      this.suggested.set(word, found);
    }
    return found;
  }
}

const spellers = new Map<ProofLanguage, SpellChecker>();

/** One speller per language, shared by every open note. */
export function spellerFor(language: ProofLanguage): SpellChecker {
  let found = spellers.get(language);
  if (!found) spellers.set(language, (found = new WorkerSpeller(language)));
  return found;
}
