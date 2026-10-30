// Highlighting for fenced code in languages CodeMirror's language-data doesn't
// know, ```mermaid say. A host passes a plain stream parser (an object with
// `token(stream, state)`, as CodeMirror's StreamLanguage takes) rather than a
// Language, so it works from another copy of CodeMirror: the bundle builds the
// Language with its own. Token names ("keyword", "string", …) map to the
// editor's highlight colours.

import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";

export type CodeLanguage = StreamParser<unknown>;

/** Fence languages from `{ name: streamParser }`; they're looked up before the built-in ones. */
export function codeLanguageDescriptions(languages: Record<string, CodeLanguage> | undefined): LanguageDescription[] {
  return Object.entries(languages ?? {}).map(([name, parser]) => {
    const support = new LanguageSupport(StreamLanguage.define({ name: name.toLowerCase(), ...parser }));
    return LanguageDescription.of({ name: name.toLowerCase(), support });
  });
}
