// Highlighting for fenced code in languages CodeMirror's language-data doesn't
// know, ```mermaid say. A host passes a plain stream parser (an object with
// `token(stream, state)`, as CodeMirror's StreamLanguage takes) rather than a
// Language, so it works from another copy of CodeMirror: the bundle builds the
// Language with its own. Token names ("keyword", "string", …) map to the
// editor's highlight colours. A function that resolves to the parser loads it
// the first time a fence uses the language; the fence is highlighted when it
// arrives.

import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";

export type CodeLanguage = StreamParser<unknown> | (() => Promise<StreamParser<unknown>>);

/** Fence languages from `{ name: streamParser }`; they're looked up before the built-in ones. */
export function codeLanguageDescriptions(languages: Record<string, CodeLanguage> | undefined): LanguageDescription[] {
  return Object.entries(languages ?? {}).map(([given, parser]) => {
    const name = given.toLowerCase();
    const support = (p: StreamParser<unknown>) => new LanguageSupport(StreamLanguage.define({ name, ...p }));
    return typeof parser === "function"
      ? LanguageDescription.of({ name, load: async () => support(await parser()) })
      : LanguageDescription.of({ name, support: support(parser) });
  });
}
