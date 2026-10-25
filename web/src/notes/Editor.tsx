import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
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
import { useEffect, useRef } from "react";
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
  onReady?: (view: EditorView) => void;
};

export function markdownExtensions(): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Highlight], addKeymap: true }),
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
  onReady,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const preview = useRef(new Compartment());
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
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
        placeholder("Start writing…"),
        markdownExtensions(),
        editorTheme,
        preview.current.of(live ? livePreview() : []),
        editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed.current?.(update.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ "aria-label": "Note text", spellcheck: "true" }),
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
    view.current?.dispatch({ effects: preview.current.reconfigure(live ? livePreview() : []) });
  }, [live]);

  return <div className="editor" ref={host} />;
}
