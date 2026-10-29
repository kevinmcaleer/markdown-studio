import { StateEffect, StateField } from "@codemirror/state";
import type { ProofLanguage } from "./speller";

// How the note is proofed, set from the status bar's language chip.

export type ProofingSettings = {
  language: ProofLanguage;
  spelling: boolean;
  grammar: boolean;
  /** Grammar goes to the server's LanguageTool (it has one, and you're signed in). */
  remoteGrammar: boolean;
  /** The server has a dictionary for Lookup. */
  lookup: boolean;
  /** The server has LibreTranslate, and you're signed in. */
  translate: boolean;
  /** The server has LibreTranslate at all, so Translate belongs in the menu. */
  translateOffered: boolean;
  /** Why Translate is off, for its tooltip. */
  translateHint: string;
  /** Why the server's tools (Look Up, Synonyms, Translate) aren't there; empty when they are, or there's no server. */
  languageNote: string;
  /** Leave spelling to the browser's own checker (and keep grammar and Look Up). */
  native?: boolean;
};

export const defaultProofing: ProofingSettings = {
  language: "en-GB",
  spelling: true,
  grammar: true,
  remoteGrammar: false,
  lookup: false,
  translate: false,
  translateOffered: false,
  translateHint: "Translation isn't set up on this server",
  languageNote: "",
};

export const LANGUAGE_NAMES: Record<ProofLanguage, string> = { "en-GB": "English (UK)", "en-US": "English (US)" };

/** Change the language or switch checks on and off in a running editor. */
export const setProofing = StateEffect.define<ProofingSettings>();

export const proofingField = StateField.define<ProofingSettings>({
  create: () => defaultProofing,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setProofing)) value = e.value;
    return value;
  },
});
