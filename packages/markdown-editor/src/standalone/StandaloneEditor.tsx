import { redoDepth, undoDepth } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { codeLanguageDescriptions } from "../codeLanguages";
import { codeEditors, codeRenderers } from "../codeRenderers";
import { recoverableDraft, DraftKeeper, type DraftState, type StoredDraft } from "../draft";
import { Editor } from "../Editor";
import { findReplace } from "../findReplace";
import { activeFormats, DEFAULT_SHORTCUTS, formatKeys, runFormat, sameActive, type Active, type ShortcutName } from "../format/formatting";
import type { FormatItem } from "../format/items";
import { linkPopover } from "../format/linkPopover";
import { selectionToolbar } from "../format/selectionToolbar";
import { useWritingLint } from "../lint/useWritingLint";
import { createMarkdownIt } from "../markdown";
import { checkSpelling, proofing as proofingExtension, setProofing, spellCount } from "../proofing/proofing";
import { useProofing } from "../proofing/useProofing";
import { slashCommands as defaultCommands, slashMenu, withInsertTexts, type SlashCommand } from "../slashMenu";
import { imageSizeMarkdown, type ImageSize } from "../imageSize";
import { insertImages, smartPaste, type SmartPasteOptions } from "../smartPaste";
import { cellCaretRect, inTable, tableNotes, tableRenderers } from "../tableWidget";
import { cardPicturePicker } from "../cardsWidget";
import { speechEditor } from "../speech/speechEditor";
import { useDictation } from "../speech/useDictation";
import { useReadAloud } from "../speech/useReadAloud";
import { countChars, countWords, readingMinutes, writingStats, type SelectionStats } from "../writingMode";
import { DraftBar } from "./DraftBar";
import { Guide, type GuideShortcut } from "./Guide";
import { ImagePicker } from "./ImagePicker";
import { DEFAULT_STATUS, DEFAULT_TOOLBAR, VIEW_SHORTCUTS, type EditorHint, type ImageInfo, type MarkdownEditor, type MountOptions, type Pane, type Stats, type ToolbarButton } from "./options";
import { Outline } from "./Outline";
import { anchorOf, type Anchor } from "./Popover";
import { PreviewPane, syncScroll, type Renderer } from "./PreviewPane";
import { StatusBar } from "./StatusBar";
import { Toolbar, VIEW_TOOLS } from "./Toolbar";
import "../format/format.css";
import "./standalone.css";

// The whole editor that `mount()` puts on a page: the Notes editor with its
// toolbar, status bar and the EasyMDE-parity extras (preview and split view,
// full screen, drafts, the image picker, the Markdown guide). Options are read
// once; the bridge is how the framework-free API in mount.tsx reaches in.

/** What mount.tsx calls into, filled in once the editor is up. */
export type Bridge = {
  view: EditorView | null;
  api: MarkdownEditor | null;
  emit: (event: string, value?: unknown) => void;
  actions: {
    setReadOnly(on: boolean): void;
    setPane(pane: Pane): void;
    setFullscreen(on: boolean): void;
    setLineNumbers(on: boolean): void;
    clearDraft(): void;
    openImagePicker(anchor?: HTMLElement): void;
    refreshPreview(): void;
    setHints(hints: EditorHint[]): void;
    checkSpelling(): void;
  } | null;
};

const SHORTCUT_LABELS: Record<ShortcutName, string> = {
  bold: "Bold",
  italic: "Italic",
  strike: "Strikethrough",
  highlight: "Highlight",
  code: "Inline code",
  link: "Link",
  paragraph: "Body text",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  headingBigger: "Bigger heading",
  headingSmaller: "Smaller heading",
  numbered: "Numbered list",
  bullet: "Bulleted list",
  checklist: "Checklist",
  indent: "Indent",
  outdent: "Outdent",
  clear: "Clear formatting",
};

/**
 * An image's Markdown on a line of its own, below the cursor's line when that
 * has text; in a table's cell, at the cursor.
 */
function insertImageLink(view: EditorView, image: ImageInfo, size?: ImageSize) {
  const alt = (image.alt ?? image.url.split(/[/?#]/).filter(Boolean).pop() ?? "").replace(/\.\w+$/, "").replace(/[[\]]/g, "");
  const markdown = `![${alt}](${image.url.replace(/[()\s]/g, encodeURIComponent)})${imageSizeMarkdown(size)}`;
  const { from, to, head } = view.state.selection.main;
  if (inTable(view.state, head)) {
    // Focused first, so the table carries on in the cell.
    view.focus();
    view.dispatch({ changes: { from, to, insert: markdown }, selection: { anchor: from + markdown.length }, userEvent: "input" });
    return;
  }
  const line = view.state.doc.lineAt(head);
  const insert = line.text.trim() ? `\n\n${markdown}\n` : markdown;
  const at = line.text.trim() ? line.to : line.from;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, scrollIntoView: true, userEvent: "input" });
  view.focus();
}

export function StandaloneEditor({ options, host, bridge }: { options: MountOptions; host: HTMLElement; bridge: Bridge }) {
  const initialDoc = useRef(options.doc ?? "").current;
  const [readOnly, setReadOnly] = useState(options.readOnly ?? false);
  const [raw, setRaw] = useState(options.raw?.start ?? false);
  const [lineNumbersOn, setLineNumbers] = useState(options.lineNumbers ?? false);
  const previewEnabled = options.preview !== false;
  const [pane, setPane] = useState<Pane>(previewEnabled ? (options.pane ?? "edit") : "edit");
  const [fullscreen, setFullscreen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(options.outline ?? false);
  const [text, setText] = useState(initialDoc);
  const deferred = useDeferredValue(text);
  const [cursor, setCursor] = useState({ pos: 0, line: 1, col: 1 });
  const [selection, setSelection] = useState<SelectionStats>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [guide, setGuide] = useState<Anchor | null>(null);
  const [picker, setPicker] = useState<Anchor | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const view = useRef<EditorView | null>(null);
  // Read once, at mount, like the Editor's other start-up options.
  const [fenceLanguages] = useState(() => codeLanguageDescriptions(options.codeLanguages));
  const previewRef = useRef<HTMLDivElement>(null);
  const live = useRef({ readOnly, pane, fullscreen });
  live.current = { readOnly, pane, fullscreen };

  // ------------------------------------------------------------ drafts
  const draftKey = options.draft?.key;
  const [recovered, setRecovered] = useState<StoredDraft | null>(() => (draftKey ? recoverableDraft(draftKey, initialDoc) : null));
  const [draftState, setDraftState] = useState<DraftState | null>(draftKey ? { status: "clean", savedAt: null } : null);
  const keeper = useMemo(() => {
    if (!options.draft?.key) return null;
    const k = new DraftKeeper(options.draft, (s) => {
      setDraftState(s);
      bridge.emit("draft", s);
    });
    // Typing before answering "Restore draft?" mustn't overwrite the draft on offer.
    k.paused = recovered !== null;
    return k;
    // Read once, like the rest of the options.
  }, []);
  useEffect(() => {
    if (!keeper) return;
    const flush = () => keeper.flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      keeper.dispose();
    };
  }, [keeper]);

  // ------------------------------------------------------------ proofing and hints
  const spellcheck = options.spellcheck ?? "built-in";
  const proofing = useProofing(Boolean(options.proofing?.languageApi || options.proofing?.languageApiBase), options.proofing?.language);
  const proofSettings = useMemo(
    () => ({ ...proofing.settings, native: spellcheck === "native", spelling: spellcheck === "native" ? false : proofing.settings.spelling }),
    [proofing.settings, spellcheck],
  );
  const proofSettingsRef = useRef(proofSettings);
  proofSettingsRef.current = proofSettings;
  const lintEnabled = options.lint !== false;
  const [spellingIssues, setSpellingIssues] = useState<number | null>(null);
  const [hints, setHints] = useState<EditorHint[]>(options.hints ?? []);
  const lint = useWritingLint(hints);

  // ------------------------------------------------------------ images
  const canUpload = Boolean(options.uploadImage);
  const usePicker = canUpload || Boolean(options.imageLibrary);
  const pasteOptions = useMemo<SmartPasteOptions>(
    () => ({
      uploadImage: options.uploadImage,
      maxBytes: options.images?.maxBytes,
      accept: options.images?.accept,
      onError: options.images?.onError,
      addImages: options.addImages,
      libraryName: options.images?.libraryName,
      noUpload: "Images can't be added here.",
    }),
    [],
  );
  // A card's picture (cardsWidget.ts) goes back to its card rather than into the text.
  const pickForCard = useRef<((picture: { src: string; alt: string }) => void) | null>(null);
  const openPickerAt = useCallback((anchor: Anchor) => {
    pickForCard.current = null;
    setPicker(anchor);
  }, []);
  const openPickerAtCursor = useCallback((v: EditorView) => {
    const at = cellCaretRect(v) ?? v.coordsAtPos(v.state.selection.main.head);
    const box = v.dom.getBoundingClientRect();
    setPicker(at ? { left: at.left, top: at.top, bottom: at.bottom } : { left: box.left, top: box.top, bottom: box.top });
  }, []);

  // ------------------------------------------------------------ "/" commands
  const commands = useMemo<SlashCommand[]>(() => {
    let list = withInsertTexts(defaultCommands, options.insertTexts);
    // With somewhere to get images from, "/image" opens the picker.
    if (usePicker) list = list.map((c) => (c.id === "image" ? { ...c, insert: undefined, run: openPickerAtCursor } : c));
    const extra = options.slashCommands;
    return typeof extra === "function" ? extra(list) : [...list, ...(extra ?? [])];
  }, []);

  // ------------------------------------------------------------ the editor's extensions (built once)
  const shortcutKeys = { ...VIEW_SHORTCUTS, ...options.shortcuts };
  // The line-number gutter: in the Raw view (unless raw.lineNumbers is false), and wherever line numbers are turned on.
  const gutter = useRef(new Compartment()).current;
  const gutterShown = lineNumbersOn || (raw && options.raw?.lineNumbers !== false);
  const gutterExtensions = (on: boolean) => (on ? [lineNumbers(), highlightActiveLineGutter()] : []);
  const viewActions = useRef({
    fullscreen: () => setFullscreen((on) => !on),
    preview: () => previewEnabled && setPane((p) => (p === "preview" ? "edit" : "preview")),
    sideBySide: () => previewEnabled && setPane((p) => (p === "split" ? "edit" : "split")),
  });
  const extensions = useMemo<Extension[]>(() => {
    const tabSize = options.raw?.tabSize ?? 2;
    const direction = options.direction ?? "auto";
    const viewKeys = (["fullscreen", "preview", "sideBySide"] as const).flatMap((name) => {
      const key = shortcutKeys[name];
      return key ? [{ key, preventDefault: true, run: () => (viewActions.current[name](), true) }] : [];
    });
    return [
      slashMenu(commands),
      smartPaste(pasteOptions),
      formatKeys(options.shortcuts),
      linkPopover(),
      options.selectionToolbar === false ? [] : selectionToolbar(),
      spellcheck === "off" ? [] : proofingExtension(),
      lintEnabled ? lint.extensions : [],
      findReplace(),
      codeRenderers.of(
        Object.fromEntries(Object.entries(options.codeRenderers ?? {}).map(([language, render]) => [language.toLowerCase(), render])),
      ),
      options.tableRenderer ? tableRenderers.of(options.tableRenderer) : [],
      usePicker
        ? cardPicturePicker.of((anchor, done) => {
            pickForCard.current = done;
            setPicker(anchorOf(anchor));
          })
        : [],
      options.tableNote ? tableNotes.of(options.tableNote) : [],
      codeEditors.of(
        Object.fromEntries(Object.entries(options.codeEditors ?? {}).map(([language, mount]) => [language.toLowerCase(), mount])),
      ),
      options.speech ? speechEditor() : [],
      writingStats({ onSelection: setSelection, onWritten: () => {} }),
      EditorState.tabSize.of(tabSize),
      indentUnit.of(options.raw?.indentWithTabs ? "\t" : " ".repeat(tabSize)),
      direction === "auto" ? EditorView.perLineTextDirection.of(true) : EditorView.contentAttributes.of({ dir: direction }),
      gutter.of(gutterExtensions(gutterShown)),
      Prec.high(keymap.of(viewKeys)),
      // Last, so menus and popovers get Escape first.
      Prec.lowest(
        keymap.of([
          {
            key: "Escape",
            run: () => {
              if (!live.current.fullscreen) return false;
              setFullscreen(false);
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const doc = u.state.doc.toString();
          setText(doc);
          keeper?.changed(doc);
          options.onChange?.(doc);
          bridge.emit("change", doc);
        }
        if (u.docChanged || u.selectionSet) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          setCursor({ pos: head, line: line.number, col: head - line.from + 1 });
          const next = activeFormats(u.state);
          setActive((prev) => (sameActive(prev, next) ? prev : next));
        }
        if (u.docChanged || u.transactions.length) {
          const undo = options.history === false || undoDepth(u.state) > 0;
          const redo = options.history === false || redoDepth(u.state) > 0;
          setHistory((h) => (h.undo === undo && h.redo === redo ? h : { undo, redo }));
        }
        const issues = u.state.field(spellCount, false);
        if (issues !== undefined && issues !== u.startState.field(spellCount, false)) setSpellingIssues(issues);
        if (u.focusChanged) bridge.emit(u.view.hasFocus ? "focus" : "blur");
      }),
      ...(options.extensions ?? []),
    ];
  }, []);
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: gutter.reconfigure(gutterExtensions(gutterShown)) });
  }, [gutterShown]);

  const openEditor = () => (view.current?.dom.isConnected ? view.current : null);
  const dictation = useDictation({ view: openEditor, enabled: Boolean(options.speech) && !readOnly });
  const readAloud = useReadAloud({ view: openEditor, doc: () => view.current?.state.doc.toString() ?? "", enabled: Boolean(options.speech) });

  const lintReady = lint.onReady;
  const onReady = useCallback((v: EditorView) => {
    view.current = v;
    bridge.view = v;
    if (spellcheck !== "off") v.dispatch({ effects: setProofing.of(proofSettingsRef.current) });
    if (lintEnabled) lintReady(v);
    setActive(activeFormats(v.state));
    if (options.autofocus) v.focus();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (spellcheck !== "off" && v?.dom.isConnected) v.dispatch({ effects: setProofing.of(proofSettings) });
  }, [proofSettings, spellcheck]);

  // ------------------------------------------------------------ preview
  const render = useMemo<Renderer>(() => {
    const p = options.preview || {};
    if (p.render) return p.render;
    const md = createMarkdownIt(p.markdownIt);
    return (markdown) => md.render(markdown);
  }, []);
  const previewClass = (options.preview && options.preview.className) || "prose";
  useEffect(() => {
    const v = view.current;
    if (pane !== "split" || !v || !previewRef.current) return;
    return syncScroll(v.scrollDOM, previewRef.current);
  }, [pane]);

  // ------------------------------------------------------------ view state on the root element
  useLayoutEffect(() => {
    host.classList.toggle("mde-fullscreen", fullscreen);
    bridge.emit("fullscreen", fullscreen);
    if (!fullscreen) return;
    // Escape leaves full screen from the toolbar or status bar too.
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setFullscreen(false);
    };
    host.addEventListener("keydown", key);
    view.current?.requestMeasure();
    return () => host.removeEventListener("keydown", key);
  }, [fullscreen]);
  useEffect(() => bridge.emit("pane", pane), [pane]);

  // ------------------------------------------------------------ stats
  const stats = useMemo<Stats>(() => {
    const words = countWords(deferred);
    return { words, chars: countChars(deferred), readingMinutes: readingMinutes(words), lines: deferred.split("\n").length };
  }, [deferred]);
  useEffect(() => bridge.emit("stats", stats), [stats]);

  // ------------------------------------------------------------ the bridge
  const restoreDraft = useCallback(() => {
    const v = view.current;
    if (!v || !recovered) return;
    if (keeper) keeper.paused = false;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: recovered.text }, userEvent: "input" });
    setRecovered(null);
  }, [recovered, keeper]);
  const discardDraft = useCallback(() => {
    setRecovered(null);
    if (!keeper) return;
    keeper.paused = false;
    keeper.clear();
    // Anything typed while the bar was up is a draft of its own.
    const doc = view.current?.state.doc.toString();
    if (doc !== undefined && doc !== initialDoc) keeper.changed(doc);
  }, [keeper]);

  // The spelling check works on the text, so it leaves the Preview for the editor first.
  const runSpelling = () => {
    const v = view.current;
    if (!v || spellcheck === "off") return;
    if (live.current.pane === "preview") setPane("edit");
    checkSpelling(v);
  };

  useLayoutEffect(() => {
    bridge.actions = {
      setReadOnly,
      setPane: (p) => setPane(previewEnabled ? p : "edit"),
      setFullscreen,
      setLineNumbers,
      clearDraft: () => {
        setRecovered(null);
        if (keeper) {
          keeper.paused = false;
          keeper.clear();
        }
      },
      openImagePicker: (anchor) => {
        const v = view.current;
        if (anchor) openPickerAt(anchorOf(anchor));
        else if (v) openPickerAtCursor(v);
      },
      refreshPreview: () => setPreviewVersion((n) => n + 1),
      setHints: (next) => setHints([...next]),
      checkSpelling: () => runSpelling(),
    };
  }, [keeper]);

  // ------------------------------------------------------------ toolbar
  const onFormat = (item: FormatItem, button: HTMLButtonElement) => {
    const v = view.current;
    if (!v) return;
    if (item.id === "image" && usePicker) return openPickerAt(anchorOf(button));
    runFormat(v, item.action);
  };
  const onTool = (id: keyof typeof VIEW_TOOLS, button: HTMLButtonElement) => {
    const v = view.current;
    switch (id) {
      case "spelling":
        runSpelling();
        break;
      case "find":
        if (v) {
          if (live.current.pane === "preview") setPane("edit");
          openSearchPanel(v);
        }
        break;
      case "outline":
        setOutlineOpen((o) => !o);
        break;
      case "raw":
        setRaw((r) => !r);
        break;
      case "line-numbers":
        setLineNumbers((on) => !on);
        break;
      case "preview":
        viewActions.current.preview();
        break;
      case "side-by-side":
        viewActions.current.sideBySide();
        break;
      case "fullscreen":
        viewActions.current.fullscreen();
        break;
      case "guide":
        setGuide((g) => (g ? null : anchorOf(button)));
        break;
    }
  };
  const onCustom = (tool: ToolbarButton, button: HTMLButtonElement) => {
    if (bridge.api) tool.run(bridge.api, button);
  };
  const customActive = (tool: ToolbarButton) => (tool.active && bridge.api ? tool.active(bridge.api) : undefined);

  const guideShortcuts = useMemo<GuideShortcut[]>(() => {
    const keys = { ...DEFAULT_SHORTCUTS, ...options.shortcuts };
    const list: GuideShortcut[] = (Object.keys(SHORTCUT_LABELS) as ShortcutName[]).flatMap((name) => (keys[name] ? [{ label: SHORTCUT_LABELS[name], keys: keys[name]! }] : []));
    list.push({ label: "Undo", keys: "Mod-z" }, { label: "Redo", keys: "Mod-Shift-z" }, { label: "Find and replace", keys: "Mod-f" });
    if (spellcheck !== "off") list.push({ label: "Check spelling", keys: "F7" });
    if (shortcutKeys.fullscreen) list.push({ label: "Full screen", keys: shortcutKeys.fullscreen });
    if (previewEnabled && shortcutKeys.preview) list.push({ label: "Preview", keys: shortcutKeys.preview });
    if (previewEnabled && shortcutKeys.sideBySide) list.push({ label: "Side by side", keys: shortcutKeys.sideBySide });
    return list;
  }, []);

  const toolbar = options.toolbar === false ? null : (options.toolbar ?? (options.speech ? [...DEFAULT_TOOLBAR, "dictate" as const] : DEFAULT_TOOLBAR));
  const status = options.status === false ? null : (options.status ?? (options.speech ? [...DEFAULT_STATUS, "read-aloud" as const] : DEFAULT_STATUS));

  return (
    <>
      {recovered && <DraftBar draft={recovered} onRestore={restoreDraft} onDiscard={discardDraft} />}
      {toolbar && active && (
        <Toolbar
          items={toolbar}
          state={{ active, readOnly, pane, fullscreen, outline: outlineOpen, raw, lineNumbers: lineNumbersOn, previewEnabled, spelling: spellcheck !== "off" && !readOnly, canUndo: history.undo, canRedo: history.redo }}
          onFormat={onFormat}
          onHeading={(block) => view.current && runFormat(view.current, { block })}
          onTool={onTool}
          onCustom={onCustom}
          customActive={customActive}
          dictation={options.speech ? dictation.button : undefined}
        />
      )}
      <div className={`mde-main pane-${pane}`}>
        {outlineOpen && (
          <Outline
            doc={deferred}
            cursor={cursor.pos}
            onJump={(pos) => {
              const v = view.current;
              if (!v) return;
              if (pane === "preview") setPane("edit");
              v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }) });
              v.focus();
            }}
          />
        )}
        <div className="mde-editor-pane">
          <Editor
            initialDoc={initialDoc}
            readOnly={readOnly}
            history={options.history ?? true}
            livePreview={!raw}
            extensions={extensions}
            placeholder={options.placeholder}
            spellcheck={spellcheck !== "off"}
            codeLanguages={fenceLanguages}
            label="Markdown"
            onReady={onReady}
          />
        </div>
        {previewEnabled && (
          <PreviewPane
            markdown={deferred}
            render={render}
            afterRender={options.preview ? options.preview.afterRender : undefined}
            className={previewClass}
            shown={pane !== "edit"}
            paneRef={previewRef}
            version={previewVersion}
          />
        )}
      </div>
      {options.speech && readAloud.bar}
      {status && (
        <StatusBar
          items={status}
          stats={stats}
          selection={selection}
          cursor={cursor}
          draft={draftState}
          proofing={spellcheck === "off" ? undefined : proofing}
          onCheckSpelling={spellcheck === "off" || readOnly ? undefined : runSpelling}
          spellingIssues={spellcheck === "off" || readOnly ? undefined : spellingIssues}
          lint={lintEnabled ? lint.status : undefined}
          readAloud={options.speech && readAloud.supported ? { reading: readAloud.reading, toggle: readAloud.toggle } : undefined}
        />
      )}
      {guide && <Guide anchor={guide} onClose={() => setGuide(null)} shortcuts={guideShortcuts} commands={commands} spelling={spellcheck !== "off"} hints={lintEnabled} sections={options.guide} />}
      {picker && view.current && (
        <ImagePicker
          anchor={picker}
          onClose={() => {
            pickForCard.current = null;
            setPicker(null);
          }}
          library={options.imageLibrary}
          doc={view.current?.state.doc.toString() ?? ""}
          canUpload={canUpload}
          accept={options.images?.accept ?? "image/*"}
          onPick={(image, size) => {
            setPicker(null);
            const card = pickForCard.current;
            pickForCard.current = null;
            if (card) return card({ src: image.url, alt: (image.alt ?? "").replace(/\.\w+$/, "") });
            if (view.current && !live.current.readOnly) insertImageLink(view.current, image, size);
          }}
          onUpload={(files) => {
            setPicker(null);
            const card = pickForCard.current;
            pickForCard.current = null;
            if (card) {
              const file = files[0];
              if (file && options.uploadImage)
                options.uploadImage(file).then(
                  (url) => card({ src: url, alt: file.name.replace(/\.\w+$/, "") }),
                  (err: unknown) => options.images?.onError?.(err instanceof Error ? err.message : "Couldn't add the picture.", file),
                );
              return;
            }
            const v = view.current;
            if (!v || live.current.readOnly) return;
            const { head } = v.state.selection.main;
            const line = v.state.doc.lineAt(head);
            // Focused first, so a table carries on in the cell the image went into.
            v.focus();
            insertImages(v, files, inTable(v.state, head) ? head : line.text.trim() ? line.to : line.from, pasteOptions);
          }}
        />
      )}
    </>
  );
}
