import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { type LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef } from "react";
import { editorHighlighting, editorTheme } from "./editorTheme";
import { Highlight } from "./highlightSyntax";
import { livePreview } from "./livePreview";

export type EditorProps = {
  /** The text to start with. Changing it later doesn't reset the editor; remount with a new `key`. */
  initialDoc: string;
  onChange?: (doc: string) => void;
  readOnly?: boolean;
  /** Keep CodeMirror's own undo history. Turn off when an extension brings its own (co-editing does). */
  history?: boolean;
  /** Show the Markdown as it reads (headings, lists, tables), with its syntax only on the cursor's line. */
  livePreview?: boolean;
  /** Extra CodeMirror extensions (comment anchors, co-editing, ...). Read once, at mount. */
  extensions?: Extension[];
  /** Extensions for when live preview is off (line numbers, say). Read once, at mount. */
  rawExtensions?: Extension[];
  /** Shown while the editor is empty. */
  placeholder?: string;
  /** The browser's own spell check. Proofing turns it off where it underlines words itself. */
  spellcheck?: boolean;
  /** More fence languages to highlight, ahead of CodeMirror's own. Read once, at mount. */
  codeLanguages?: LanguageDescription[];
  /** What a screen reader calls the text area. */
  label?: string;
  onReady?: (view: EditorView) => void;
};

export function markdownExtensions(extraLanguages: LanguageDescription[] = []): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: [...extraLanguages, ...languages], extensions: [Highlight], addKeymap: true }),
    keymap.of(markdownKeymap),
    editorHighlighting,
  ];
}

export function Editor({
  initialDoc,
  onChange,
  readOnly = false,
  history: ownHistory = true,
  livePreview: live = false,
  extensions = [],
  rawExtensions = [],
  placeholder: emptyText = "Start writing…",
  spellcheck = true,
  codeLanguages = [],
  label = "Note text",
  onReady,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const preview = useRef(new Compartment());
  const changed = useRef(onChange);
  changed.current = onChange;

  // Built before paint, so a host that mounts the editor can use it straight away.
  useLayoutEffect(() => {
    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        ownHistory ? history() : [],
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...(ownHistory ? historyKeymap : []), indentWithTab]),
        placeholder(emptyText),
        markdownExtensions(codeLanguages),
        editorTheme,
        preview.current.of(live ? livePreview() : rawExtensions),
        editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed.current?.(update.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": label, spellcheck: String(spellcheck) }),
        ...extensions,
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    onReady?.(view.current);
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // The editor is built once per mount; see the `initialDoc` note above.
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: preview.current.reconfigure(live ? livePreview() : rawExtensions) });
  }, [live]);

  return <div className="editor" ref={host} />;
}
