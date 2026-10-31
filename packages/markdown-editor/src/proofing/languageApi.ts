// The server's half of the language tools. Lookup is local to the server;
// grammar and translation go to LanguageTool and LibreTranslate when the
// server has them set up. Markdown Studio's server answers under /api/language;
// another host points the editor at its own (or none) with `configureLanguageApi`.

/** Sends one request to the language API: a GET without a body, a POST of JSON with one. */
export type LanguageRequest = <T>(path: string, options?: { body?: unknown }) => Promise<T>;

/** A request function for a language API under `base` ("https://example.com" or "/studio"). */
export function fetchLanguageApi(base: string): LanguageRequest {
  const root = base.replace(/\/+$/, "");
  return async <T>(path: string, options: { body?: unknown } = {}) => {
    const response = await fetch(root + path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: options.body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw Object.assign(new Error(`${response.status}`), { status: response.status });
    return (await response.json()) as T;
  };
}

// No server until one is configured: spelling and the built-in grammar rules work without it.
let api: LanguageRequest | null = null;

/** Where Look Up, LanguageTool grammar and translation go. Null turns them off. */
export function configureLanguageApi(request: LanguageRequest | null): void {
  api = request;
  features = null;
  definitions.clear();
  targets = null;
}

function request<T>(path: string, options?: { body?: unknown }): Promise<T> {
  return api ? api<T>(path, options) : Promise.reject(Object.assign(new Error("No language server"), { status: 0 }));
}

export type LanguageFeatures = {
  lookup: boolean;
  grammar: boolean;
  translate: boolean;
  /** Why there's nothing: no server configured, the server can't be reached, or it wants you signed in. */
  unavailable?: "none" | "offline" | "signin";
};

export type Sense = { definition: string; examples: string[]; synonyms: string[] };
export type Definition = { word: string; lemma: string; entries: { pos: string; lemma: string; senses: Sense[] }[] };

export type GrammarSegment = { text?: string; markup?: string; interpretAs?: string };
export type GrammarMatch = { offset: number; length: number; message: string; short: string; replacements: string[]; rule: string };

const NONE: LanguageFeatures = { lookup: false, grammar: false, translate: false };
let features: Promise<LanguageFeatures> | null = null;

/** How long to wait before asking a second time when the server didn't answer. */
export const FEATURES_RETRY_MS = 1500;

const offline = (err: unknown) => {
  const status = (err as { status?: number } | null)?.status;
  return status !== 401 && status !== 403;
};

/**
 * What this server offers. Asked once while it answers; a failure is asked again next time.
 * One dropped request (a tunnel blip, a slow wake-up) isn't enough to call it offline:
 * it's asked a second time, a moment later, first.
 */
export function languageFeatures(): Promise<LanguageFeatures> {
  if (!features) {
    const ask = () => request<LanguageFeatures>("/api/language");
    features = ask()
      .catch((err) => (api && offline(err) ? new Promise((r) => setTimeout(r, FEATURES_RETRY_MS)).then(ask) : Promise.reject(err)))
      .catch((err) => {
        features = null;
        const unavailable = !api ? "none" : offline(err) ? "offline" : "signin";
        return { ...NONE, unavailable };
      });
  }
  return features;
}

const definitions = new Map<string, Promise<Definition | null>>();

/** A definition, or null when the dictionary doesn't have the word. */
export function define(word: string): Promise<Definition | null> {
  const key = word.toLowerCase();
  let found = definitions.get(key);
  if (!found) {
    found = request<Definition>(`/api/language/define?word=${encodeURIComponent(word)}`).catch((err) => {
      definitions.delete(key);
      if (err?.status === 404) return null;
      throw err;
    });
    definitions.set(key, found);
  }
  return found;
}

export function checkGrammar(language: string, annotation: GrammarSegment[]) {
  return request<{ matches: GrammarMatch[] }>("/api/language/check", { body: { language, annotation } }).then((r) => r.matches);
}

let targets: Promise<{ code: string; name: string }[]> | null = null;

export function translationLanguages() {
  if (!targets) {
    targets = request<{ languages: { code: string; name: string }[] }>("/api/language/translate/languages").then(
      (r) => r.languages,
      (err) => {
        targets = null;
        throw err;
      },
    );
  }
  return targets;
}

export function translate(text: string, target: string) {
  return request<{ text: string; detected: string | null }>("/api/language/translate", { body: { text, target } });
}
