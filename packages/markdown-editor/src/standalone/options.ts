import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CodeLanguage } from "../codeLanguages";
import type { CodeEditor, CodeRenderer } from "../codeRenderers";
import type { DraftOptions, DraftState } from "../draft";
import type { ShortcutName } from "../format/formatting";
import type { EditorHint } from "../lint/useWritingLint";
import type { MarkdownItInstance } from "../markdown";
import type { LanguageRequest } from "../proofing/languageApi";
import type { ProofLanguage } from "../proofing/speller";
import type { InsertTexts, SlashCommand } from "../slashMenu";
import type { TableRenderer } from "../tableWidget";

// The options `mount()` takes, and the editor it hands back. Every option has
// a default, so `mount(el)` alone gives the full editor.

export type { EditorHint };

/** A built-in toolbar button, by name; "|" draws a separator. */
export type BuiltInTool =
  | "undo"
  | "redo"
  | "heading"
  | "headingBigger"
  | "headingSmaller"
  | "bold"
  | "italic"
  | "strike"
  | "highlight"
  | "code"
  | "link"
  | "bullet"
  | "numbered"
  | "checklist"
  | "outdent"
  | "indent"
  | "quote"
  | "codeBlock"
  | "table"
  | "image"
  | "divider"
  | "clear"
  | "find"
  | "outline"
  | "raw"
  | "line-numbers"
  | "preview"
  | "side-by-side"
  | "fullscreen"
  | "guide"
  | "dictate"
  | "|";

/** A host's own button. */
export type ToolbarButton = {
  id: string;
  /** The tooltip and accessible name. */
  label: string;
  /**
   * A 16×16 stroke path ("M2 8h12"), an `<svg>…</svg>` string, or a short
   * text label ("Diagram"). Left out, the label is shown.
   */
  icon?: string;
  /** Runs on click; `button` is the clicked element, to anchor a menu to. */
  run: (editor: MarkdownEditor, button: HTMLButtonElement) => void;
  /** Shows the button as pressed. Asked again after each edit. */
  active?: (editor: MarkdownEditor) => boolean;
};

export type ToolbarItem = BuiltInTool | ToolbarButton;

/** Status bar items, in the order given. */
export type StatusItem = "words" | "chars" | "reading" | "lines" | "cursor" | "draft" | "language" | "lint" | "read-aloud";

export type ImageInfo = {
  url: string;
  alt?: string;
  thumb?: string;
  /** Marks the image as already in the text. Left out, the picker checks
   *  the text for the image's URL itself. */
  used?: boolean;
};

export type Pane = "edit" | "preview" | "split";


export type Stats = { words: number; chars: number; readingMinutes: number; lines: number };

export type EditorEvents = {
  change: string;
  stats: Stats;
  draft: DraftState;
  focus: void;
  blur: void;
  pane: Pane;
  fullscreen: boolean;
};

export type MountOptions = {
  /** The Markdown to start with. On a `<textarea>`, defaults to its value. */
  doc?: string;
  onChange?: (doc: string) => void;
  readOnly?: boolean;

  /** Shown while the document is empty. Defaults to "Start writing…". */
  placeholder?: string;
  autofocus?: boolean;
  /** CSS lengths (numbers are pixels). Defaults: 12rem, no maximum. */
  minHeight?: string | number;
  maxHeight?: string | number;
  /** Defaults to "auto", following the system. */
  theme?: "light" | "dark" | "auto";
  /** Defaults to "auto": each line's own script decides. */
  direction?: "ltr" | "rtl" | "auto";
  /** "built-in" (Hunspell, grammar, Look Up; the default), "native" (the browser's), or "off". */
  spellcheck?: "built-in" | "native" | "off";

  /** Buttons in order, or false for none. Defaults to DEFAULT_TOOLBAR. */
  toolbar?: ToolbarItem[] | false;
  /** The floating toolbar over selected text. Defaults to on. */
  selectionToolbar?: boolean;
  /** Status bar items in order, or false for none. Defaults to DEFAULT_STATUS. */
  status?: StatusItem[] | false;

  /** Commands added to the "/" menu, or a function given the defaults that returns the full list. */
  slashCommands?: SlashCommand[] | ((defaults: SlashCommand[]) => SlashCommand[]);
  /** EasyMDE-style templates for the link, image, table, horizontal rule and code inserts. */
  insertTexts?: InsertTexts;
  /** Keys for the formatting and view shortcuts: a key to move one, null to turn it off. */
  shortcuts?: Partial<Record<ShortcutName | "fullscreen" | "preview" | "sideBySide", string | null>>;

  /** Stores a pasted, dropped or picked image and returns its URL. Without it, images can't be added. */
  uploadImage?: (file: File) => Promise<string>;
  /**
   * Keeps several images dropped on the text at once without linking them
   * (the host's gallery, say). Without it, they're all linked where they land.
   * One dropped image is always uploaded and linked between the lines it's dropped between.
   */
  addImages?: (files: File[]) => Promise<void>;
  /** Images to pick from in the image picker (the toolbar's image button and "/image"). */
  imageLibrary?: () => Promise<ImageInfo[]>;
  images?: {
    /** Defaults to 25 MB. */
    maxBytes?: number;
    /** An `<input accept>` list. Defaults to "image/*". */
    accept?: string;
    onError?: (message: string, file: File) => void;
    /** What `addImages` keeps images in, for the notes ("Added 3 images to the gallery"). Defaults to "the image library". */
    libraryName?: string;
  };

  /**
   * The Preview and Side by side views. `render` turns Markdown into HTML the
   * way the host publishes it; it can return the HTML (or a promise of it), or
   * fill `element` itself and return nothing. Without it the built-in renderer
   * is used, and `markdownIt` can add plugins to that. False hides both views.
   */
  preview?:
    | false
    | {
        render?: (markdown: string, element: HTMLElement) => string | void | Promise<string | void>;
        markdownIt?: (md: MarkdownItInstance) => MarkdownItInstance | void;
        /** Runs after each render, with the preview element (to run mermaid on it, say). */
        afterRender?: (element: HTMLElement) => void;
        /** Classes for the preview element. Defaults to "prose". */
        className?: string;
      };
  /**
   * Fenced blocks to draw in the live view, by language: ```mermaid shows as
   * its diagram, say, and as its source while the cursor is in it. Each one
   * draws `source` into `element` (and may finish later).
   */
  codeRenderers?: Record<string, CodeRenderer>;
  /**
   * Draws a table some other way in the live view: a Videos table as a gallery
   * of thumbnails, say. It's given the table's cells and the heading it sits
   * under, and returns an element, or null to keep the grid. The drawing shows
   * until the table is clicked or the caret moves in, then the grid to edit.
   */
  tableRenderer?: TableRenderer;
  /**
   * Editors for fenced blocks, by language: while the cursor is in a ```mermaid
   * block, say, it shows as this editor (code beside its live diagram) in place
   * of its lines. Each one mounts into `element`, reports edits with `onChange`
   * and can hand the cursor back with `onExit("before" | "after")`.
   */
  codeEditors?: Record<string, CodeEditor>;
  /**
   * Highlighting for fenced code in more languages, by name: a plain stream
   * parser (`{ token(stream, state), startState? }`, as CodeMirror's
   * StreamLanguage takes), so it can come from another bundle, such as
   * Mermaid Factory's `mermaidStreamParser`. A function resolving to one
   * loads it the first time a fence needs it. Read once, at mount.
   */
  codeLanguages?: Record<string, CodeLanguage>;
  /** Which view to open in. Defaults to "edit". */
  pane?: Pane;
  /** Line numbers beside the live view too (the Raw view has its own, see `raw.lineNumbers`). The "line-numbers" button toggles them. */
  lineNumbers?: boolean;
  /** Start in the Raw view (all the Markdown, line numbers) rather than the live one. */
  raw?: { start?: boolean; lineNumbers?: boolean; tabSize?: number; indentWithTabs?: boolean };

  /** Keeps a draft in this browser and offers it back after a crash or reload. Off without a key. */
  draft?: DraftOptions;

  proofing?: {
    /** A Markdown Studio server for Look Up, LanguageTool grammar and translation ("https://studio.example.com"). */
    languageApiBase?: string;
    /**
     * Sends the language API's requests yourself, in place of `languageApiBase`'s fetch: to add
     * an Authorization header, say. Wrap `MarkdownEditor.fetchLanguageApi` or write your own.
     */
    languageApi?: LanguageRequest;
    /** Where `en-GB.dic` and `en-US.dic` are. Defaults to `dictionaries/` beside the script. */
    dictionaryBase?: string;
    /** The proofing language until the writer picks one. Defaults to en-GB. */
    language?: ProofLanguage;
  };
  /** Writing hints (passive voice, long sentences…) in the status bar. Defaults to on. */
  lint?: boolean;
  /** The host's own hints, listed above the writing hints. Change them with `setHints`. */
  hints?: EditorHint[];
  /** Opens the outline (the headings) beside the text. */
  outline?: boolean;
  /** Dictation and read aloud, where the browser can. Defaults to off. */
  speech?: boolean;

  /** More CodeMirror extensions (co-editing from "@markdown-studio/markdown-editor/collab", say). */
  extensions?: Extension[];
  /** CodeMirror's undo history. Turn it off when an extension brings its own (co-editing does). */
  history?: boolean;
};

export interface MarkdownEditor {
  /** The element the editor was mounted in (its `.mde` root). */
  readonly element: HTMLElement;
  /** The CodeMirror view, for anything the API doesn't cover. */
  readonly view: EditorView;
  getDoc(): string;
  /** Replaces the whole document (a dropped README, say). It's one step to undo. */
  setDoc(doc: string): void;
  /** The selected text. */
  getSelection(): string;
  /** Puts text in place of the selection, or at the cursor. */
  replaceSelection(text: string): void;
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  setPane(pane: Pane): void;
  setFullscreen(on: boolean): void;
  /** Line numbers beside the live view (the Raw view keeps its own). */
  setLineNumbers(on: boolean): void;
  /** Forgets the stored draft: call it once the host has saved. */
  clearDraft(): void;
  openLinkPopover(): void;
  openImagePicker(anchor?: HTMLElement): void;
  /** Re-runs the preview (after the host's renderer changes, say). */
  refreshPreview(): void;
  /** Replaces the host's hints in the hints panel; `[]` clears them. Needs `lint` on. */
  setHints(hints: EditorHint[]): void;
  on<K extends keyof EditorEvents>(event: K, listener: (value: EditorEvents[K]) => void): () => void;
  off<K extends keyof EditorEvents>(event: K, listener: (value: EditorEvents[K]) => void): void;
  /** Takes the editor out of the page; a `<textarea>` it was mounted on comes back. */
  destroy(): void;
}

export const DEFAULT_TOOLBAR: BuiltInTool[] = [
  "undo",
  "redo",
  "|",
  "heading",
  "|",
  "bold",
  "italic",
  "strike",
  "highlight",
  "code",
  "link",
  "|",
  "bullet",
  "numbered",
  "checklist",
  "outdent",
  "indent",
  "|",
  "quote",
  "codeBlock",
  "table",
  "image",
  "divider",
  "|",
  "preview",
  "side-by-side",
  "fullscreen",
  "|",
  "guide",
];

export const DEFAULT_STATUS: StatusItem[] = ["words", "chars", "reading", "cursor", "draft", "language", "lint"];

export const VIEW_SHORTCUTS = { fullscreen: "Mod-Shift-f", preview: "Mod-Shift-p", sideBySide: "F9" };
