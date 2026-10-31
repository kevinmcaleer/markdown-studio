// @vitest-environment happy-dom
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { afterEach, describe, expect, it } from "vitest";
import { card, diagnostics, type Diagnostic } from "../diagnostics";
import { configureLanguageApi, type LanguageRequest } from "../proofing/languageApi";
import { activeRewrite, rewriteAsActive, sentenceAround, watchRewrite } from "./rewrite";
import { toDiagnostic } from "./writingLint";

const around = (doc: string, phrase: string) => {
  const from = doc.indexOf(phrase);
  return sentenceAround(Text.of(doc.split("\n")), from, from + phrase.length)?.text ?? null;
};

describe("sentenceAround", () => {
  it("finds the sentence the phrase is in, not its neighbours", () => {
    const doc = "I like robots. The code was written by Kev. It works!";
    expect(around(doc, "was written")).toBe("The code was written by Kev.");
    expect(around("It was written", "was written")).toBe("It was written");
  });

  it("leaves out quote, callout, list and heading markers", () => {
    expect(around("> As with many projects, the way it is presented bugs me. Next.", "is presented")).toBe(
      "As with many projects, the way it is presented bugs me.",
    );
    expect(around("- [x] The parts were bought online", "were bought")).toBe("The parts were bought online");
    expect(around("## It was built in a week", "was built")).toBe("It was built in a week");
    expect(around("1. The servo is driven by a Pico.", "is driven")).toBe("The servo is driven by a Pico.");
  });

  it("keeps to one table cell and ignores dots inside words", () => {
    expect(around("| Pico | It is powered by a 5v.supply |", "is powered")).toBe("It is powered by a 5v.supply");
  });

  it("gives up on a hint that runs onto the next line", () => {
    const doc = "It was\nwritten";
    expect(sentenceAround(Text.of(doc.split("\n")), 3, 14)).toBeNull();
  });
});

describe("Rewrite as active", () => {
  const server = (answer: (path: string, body: unknown) => unknown): { sent: unknown[] } => {
    const sent: unknown[] = [];
    const request: LanguageRequest = async <T,>(path: string, options: { body?: unknown } = {}) => {
      sent.push(options.body);
      const value = answer(path, options.body);
      if (value instanceof Error) throw value;
      return value as T;
    };
    configureLanguageApi(request);
    return { sent };
  };
  afterEach(() => configureLanguageApi(null));

  const passive = (doc: string, phrase: string): [EditorState, Diagnostic] => {
    const state = EditorState.create({ doc });
    const from = doc.indexOf(phrase);
    return [state, toDiagnostic({ rule: "passive", from, to: from + phrase.length, message: "m" })];
  };

  it("is offered on passive-voice hints only", () => {
    expect(passive("It was written.", "was written")[1].suggest).toBe(rewriteAsActive);
    expect(toDiagnostic({ rule: "adverb", from: 0, to: 1, message: "m" }).suggest).toBeUndefined();
  });

  it("asks the server for the sentence and offers to replace just that sentence", async () => {
    const { sent } = server(() => ({ text: "Kev wrote the code." }));
    const [state, d] = passive("Hello. The code was written by Kev. Bye.", "was written");
    expect(await activeRewrite(state, d)).toEqual({ label: "Use this", from: 7, to: 35, insert: "Kev wrote the code." });
    expect(sent[0]).toEqual({ text: "The code was written by Kev.", phrase: "was written", style: "active", language: "en-GB" });
  });

  it("says so when there's nothing better, or the server says no", async () => {
    const [state, d] = passive("It was written.", "was written");
    server(() => ({ text: "It was written." }));
    expect(await activeRewrite(state, d)).toMatch(/no clear active version/);
    server(() => Object.assign(new Error("429"), { status: 429 }));
    expect(await activeRewrite(state, d)).toMatch(/Try again shortly/);
    server(() => Object.assign(new Error("401"), { status: 401 }));
    expect(await activeRewrite(state, d)).toMatch(/Sign in/);
  });

  it("is only offered when the server can rewrite", async () => {
    server(() => ({ lookup: false, grammar: false, translate: false, rewrite: true }));
    watchRewrite();
    await new Promise((r) => setTimeout(r, 0));
    expect(rewriteAsActive.available!()).toBe(true);
    server(() => ({ lookup: false, grammar: false, translate: false }));
    watchRewrite();
    await new Promise((r) => setTimeout(r, 0));
    expect(rewriteAsActive.available!()).toBe(false);
  });
});

describe("the hover card's rewrite", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const setup = (doc: string, phrase: string, answer: () => Promise<string | { label: string; from: number; to: number; insert: string }>) => {
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [diagnostics(), history()] }), parent: document.body });
    const from = doc.indexOf(phrase);
    const d: Diagnostic = {
      from,
      to: from + phrase.length,
      source: "lint",
      rule: "passive",
      title: "Passive voice",
      message: "m",
      suggest: { label: "Rewrite as active", busy: "Rewriting…", run: answer },
    };
    const dom = card(view, [d]);
    return { view, dom, button: dom.querySelector<HTMLButtonElement>(".cm-diag-suggest")! };
  };

  it("shows the suggestion first, then replaces the sentence on Use this, and undo puts it back", async () => {
    const { view, dom, button } = setup("The code was written by Kev.", "was written", async () => ({ label: "Use this", from: 0, to: 28, insert: "Kev wrote the code." }));
    button.click();
    expect(button.textContent).toBe("Rewriting…");
    await settle();
    expect(dom.querySelector(".cm-diag-preview del")!.textContent).toBe("The code was written by Kev.");
    expect(dom.querySelector(".cm-diag-preview ins")!.textContent).toBe("Kev wrote the code.");
    expect(view.state.doc.toString()).toBe("The code was written by Kev.");
    dom.querySelector<HTMLButtonElement>(".cm-diag-use")!.click();
    expect(view.state.doc.toString()).toBe("Kev wrote the code.");
    undo(view);
    expect(view.state.doc.toString()).toBe("The code was written by Kev.");
    view.destroy();
  });

  it("Dismiss leaves the text alone", async () => {
    const { view, dom, button } = setup("It was written.", "was written", async () => ({ label: "Use this", from: 0, to: 15, insert: "I wrote it." }));
    button.click();
    await settle();
    [...dom.querySelectorAll<HTMLButtonElement>(".cm-diag-preview button")].find((b) => b.textContent === "Dismiss")!.click();
    expect(dom.querySelector(".cm-diag-preview")).toBeNull();
    expect(view.state.doc.toString()).toBe("It was written.");
    view.destroy();
  });

  it("won't replace a sentence that changed while you looked", async () => {
    const { view, dom, button } = setup("It was written.", "was written", async () => ({ label: "Use this", from: 0, to: 15, insert: "I wrote it." }));
    button.click();
    await settle();
    view.dispatch({ changes: { from: 0, insert: "X" } });
    dom.querySelector<HTMLButtonElement>(".cm-diag-use")!.click();
    expect(view.state.doc.toString()).toBe("XIt was written.");
    expect(dom.querySelector(".cm-diag-preview")!.textContent).toMatch(/sentence changed/);
    view.destroy();
  });

  it("shows a note instead when there's no suggestion", async () => {
    const { view, dom, button } = setup("It was written.", "was written", async () => "There's no clear active version of this one.");
    button.click();
    await settle();
    expect(dom.querySelector(".cm-diag-preview")!.textContent).toMatch(/no clear active version/);
    expect(dom.querySelector(".cm-diag-use")).toBeNull();
    view.destroy();
  });
});
