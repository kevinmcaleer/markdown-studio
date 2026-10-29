import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { fence, htmlToMarkdown } from "./htmlToMarkdown";
import { cellAt, diff, pasteCells, spreadsheetCells, tableFromCells } from "./markdownTable";

// Smart paste: what's on the clipboard arrives as Markdown. Rich text becomes
// headings, lists, links and tables; spreadsheet cells a table (or fill the
// table you're in); a URL over selected text a link; code from an IDE a fence;
// pasted and dropped images are uploaded and linked. A note under the caret
// says what happened and offers the plain text instead. Nothing here goes
// through the server except image uploads, and only the browser looks up a
// pasted link's title, so the server never fetches outside URLs.

export type SmartPasteOptions = {
  /** Stores an image and returns the URL to link it by. Leave out where uploads aren't possible (signed out). */
  uploadImage?: (file: File) => Promise<string>;
  /** Look up the title of a bare pasted URL in the browser. Defaults to on. */
  linkTitles?: boolean;
  /** The largest image to upload, in bytes. Bigger ones are turned away with a note. Defaults to 25 MB. */
  maxBytes?: number;
  /** Which images to take, as an `<input accept>` list ("image/png,image/jpeg", ".webp"). Defaults to any image. */
  accept?: string;
  /** Called when an image is turned away or its upload fails, with the reason shown in the note. */
  onError?: (message: string, file: File) => void;
  /** What the note says when an image is pasted and there's no `uploadImage`. */
  noUpload?: string;
};

export const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Whether a file matches an `<input accept>` list. */
export function accepts(file: File, accept = "image/*"): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .some((a) => (a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));
}

/** "25 MB", "512 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${+(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Why an image can't go in, or null when it can. */
export function imageProblem(file: File, options: SmartPasteOptions): string | null {
  if (!accepts(file, options.accept)) return `${file.name || "This file"} isn't a kind of image this editor takes.`;
  const max = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (file.size > max) return `${file.name || "This image"} is ${formatBytes(file.size)}; the most is ${formatBytes(max)}.`;
  return null;
}

export type Clip = {
  text: string;
  html: string;
  /** VS Code's own clipboard entry, which names the language. */
  vscode?: string;
};

export type PastePlan = {
  from: number;
  to: number;
  insert: string;
  /** What the note under the caret says. None for pastes that are what you'd expect anyway. */
  label?: string;
  /** The plain text, for "Paste as plain text". */
  plain?: string;
  /** A bare URL whose page title could be its link text. */
  titleFor?: string;
};

const URL_ONLY = /^(?:https?:\/\/|mailto:)[^\s<>"]+$/i;

/** Where the selection is in code (a fence, an indented block, inline code), pastes stay as they are. */
function inCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "CommentBlock"].includes(node.name)) return true;
  }
  return false;
}

function inNode(state: EditorState, pos: number, names: string[]) {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (names.includes(node.name)) return node;
  }
  return null;
}

/** VS Code's language ids as fence languages. */
function vscodeLanguage(data?: string): string | null {
  if (!data) return null;
  try {
    const mode = String(JSON.parse(data).mode ?? "");
    const names: Record<string, string> = {
      typescriptreact: "tsx",
      javascriptreact: "jsx",
      shellscript: "bash",
      plaintext: "",
      jsonc: "json",
    };
    return mode in names ? names[mode] : mode;
  } catch {
    return null;
  }
}

/** Text that goes on lines of its own: blank lines around it, unless it's already at a line's edge. */
function asBlock(state: EditorState, from: number, to: number, text: string): string {
  const start = state.doc.lineAt(from);
  const end = state.doc.lineAt(to);
  const before = state.sliceDoc(start.from, from);
  const after = state.sliceDoc(to, end.to);
  const prev = start.number > 1 ? state.doc.line(start.number - 1).text : "";
  const next = end.number < state.doc.lines ? state.doc.line(end.number + 1).text : "";
  const lead = before.trim() ? "\n\n" : prev.trim() && !before ? "\n" : "";
  const tail = after.trim() ? "\n\n" : next.trim() && !after ? "\n" : "";
  return lead + text + tail;
}

function isBlockMarkdown(markdown: string): boolean {
  return markdown.includes("\n") || /^(#{1,6}\s|[-+*]\s|\d+[.)]\s|>|\||```|---$)/.test(markdown);
}

/** Markdown and plain text that read the same once escapes and spacing are ignored. */
function sameText(markdown: string, plain: string): boolean {
  const norm = (s: string) => s.replace(/\\\n/g, " ").replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
  return norm(markdown) === norm(plain);
}

/** What a paste of `clip` over the selection should insert, or null to let it paste as it is. */
export function planPaste(state: EditorState, clip: Clip): PastePlan | null {
  const { from, to } = state.selection.main;
  if (inCode(state, from)) return null;
  const text = clip.text;
  const trimmed = text.trim();

  if (URL_ONLY.test(trimmed)) {
    const selected = state.sliceDoc(from, to);
    if (selected && !selected.includes("\n") && !URL_ONLY.test(selected.trim())) {
      return { from, to, insert: `[${selected}](${trimmed})` };
    }
    // Already writing a link or an autolink: just the URL.
    const before = state.sliceDoc(Math.max(0, from - 2), from);
    if (selected || /[(<[]$|\]\($/.test(before) || inNode(state, from, ["Link", "URL", "Autolink", "Image"])) return null;
    return { from, to, insert: trimmed, titleFor: trimmed };
  }

  const cells = spreadsheetCells(text, clip.html);
  if (cells) {
    const table = inNode(state, from, ["Table"]);
    if (table && from === to) {
      const source = state.sliceDoc(table.from, table.to);
      const [row, col] = cellAt(source, from - table.from);
      const change = diff(source, pasteCells(source, row, col, cells));
      if (!change) return null;
      return { from: table.from + change.from, to: table.from + change.to, insert: change.insert };
    }
    return { from, to, insert: asBlock(state, from, to, tableFromCells(cells)), label: "Pasted as a table", plain: text };
  }

  const language = vscodeLanguage(clip.vscode);
  if (language !== null && trimmed.includes("\n")) {
    return { from, to, insert: asBlock(state, from, to, fence(text, language)), label: "Pasted as code", plain: text };
  }

  if (clip.html) {
    const markdown = htmlToMarkdown(clip.html);
    if (!markdown || sameText(markdown, text)) return null;
    const insert = isBlockMarkdown(markdown) ? asBlock(state, from, to, markdown) : markdown;
    return { from, to, insert, label: "Pasted as Markdown", plain: text };
  }
  return null;
}

// ---------------------------------------------------------------- tracked ranges

// Ranges that later work comes back to (the plain-text offer, a link waiting
// for its title, an image uploading), kept in step with edits, including
// other people's.

type Span = { from: number; to: number };
const track = StateEffect.define<{ id: number; span: Span }>();
const untrack = StateEffect.define<number>();

const tracked = StateField.define<ReadonlyMap<number, Span>>({
  create: () => new Map(),
  update(spans, tr) {
    let next = spans;
    if (tr.docChanged && spans.size) {
      const mapped = new Map<number, Span>();
      for (const [id, span] of spans) {
        const from = tr.changes.mapPos(span.from, 1);
        const to = Math.max(from, tr.changes.mapPos(span.to, -1));
        mapped.set(id, { from, to });
      }
      next = mapped;
    }
    for (const effect of tr.effects) {
      if (effect.is(track)) next = new Map(next).set(effect.value.id, effect.value.span);
      else if (effect.is(untrack) && next.has(effect.value)) {
        const without = new Map(next);
        without.delete(effect.value);
        next = without;
      }
    }
    return next;
  },
});

let nextId = 1;

/** Replaces a tracked range, if it still holds `expect`. */
function replaceTracked(view: EditorView, id: number, expect: string, insert: string) {
  const span = view.state.field(tracked).get(id);
  const effects = [untrack.of(id)];
  if (!span || view.state.sliceDoc(span.from, span.to) !== expect) {
    view.dispatch({ effects });
    return;
  }
  view.dispatch({ changes: { from: span.from, to: span.to, insert }, effects, userEvent: "input.paste" });
}

// ---------------------------------------------------------------- the note under the caret

type Notice = { id: number; message: string; plain?: string; error?: boolean };
const setNotice = StateEffect.define<Notice | null>();

const noticeField = StateField.define<Notice | null>({
  create: () => null,
  update(notice, tr) {
    for (const effect of tr.effects) if (effect.is(setNotice)) return effect.value;
    // Carrying on typing means the paste was what you wanted.
    if (notice && (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("undo"))) return null;
    return notice;
  },
});

const noticeTooltip = showTooltip.compute([noticeField, tracked], (state): Tooltip | null => {
  const notice = state.field(noticeField);
  const span = notice && state.field(tracked).get(notice.id);
  if (!notice || !span) return null;
  return {
    pos: span.to,
    above: false,
    create: (view) => noticeView(view, notice),
  };
});

const shown = new WeakMap<Notice, number>();

function noticeView(view: EditorView, notice: Notice) {
  const dom = document.createElement("div");
  dom.className = `cm-paste-notice${notice.error ? " error" : ""}`;
  dom.setAttribute("role", "status");
  dom.addEventListener("mousedown", (e) => e.preventDefault());
  const message = document.createElement("span");
  message.textContent = notice.message;
  dom.append(message);
  if (notice.plain !== undefined) {
    const plain = document.createElement("button");
    plain.type = "button";
    plain.textContent = "Paste as plain text";
    plain.addEventListener("click", () => {
      const span = view.state.field(tracked).get(notice.id);
      if (span)
        view.dispatch({
          changes: { from: span.from, to: span.to, insert: notice.plain! },
          selection: { anchor: span.from + notice.plain!.length },
          effects: [setNotice.of(null), untrack.of(notice.id)],
          userEvent: "input.paste",
        });
      view.focus();
    });
    dom.append(" · ", plain);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => dismiss(view, notice.id));
  dom.append(close);
  // Moving the note with the text redraws it; the time it's up for runs from the first draw.
  const since = shown.get(notice) ?? Date.now();
  shown.set(notice, since);
  const timer = setTimeout(() => dismiss(view, notice.id), Math.max(0, (notice.error ? 10000 : 8000) - (Date.now() - since)));
  return { dom, destroy: () => clearTimeout(timer) };
}

function dismiss(view: EditorView, id: number) {
  if (view.state.field(noticeField)?.id !== id) return;
  view.dispatch({ effects: [setNotice.of(null), untrack.of(id)] });
}

function noticeAt(view: EditorView, pos: number, message: string, error = true) {
  const id = nextId++;
  view.dispatch({ effects: [track.of({ id, span: { from: pos, to: pos } }), setNotice.of({ id, message, error })] });
}

// ---------------------------------------------------------------- link titles

/** The page's <title>, fetched by the browser; null when the site doesn't allow it (most don't) or it's slow. */
async function pageTitle(url: string): Promise<string | null> {
  if (!/^https?:/i.test(url)) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4000);
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit", signal: abort.signal });
    if (!response.ok || !response.headers.get("content-type")?.includes("html")) return null;
    const head = (await response.text()).slice(0, 200_000);
    const title = new DOMParser().parseFromString(head, "text/html").querySelector("title")?.textContent;
    return title?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

// ---------------------------------------------------------------- images

function imagesIn(files: FileList | null | undefined): File[] {
  return Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
}

/** A name for a pasted image: screenshots arrive as just "image.png". */
function imageName(file: File): File {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*/, "") || "png";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return new File([file], `Pasted image ${stamp}.${ext}`, { type: file.type });
}

/** Uploads the images and links them at `at`, with a placeholder while they upload. */
export function insertImages(view: EditorView, images: File[], at: number, options: SmartPasteOptions) {
  const upload = options.uploadImage;
  if (!upload) {
    noticeAt(view, at, options.noUpload ?? "Sign in to add images to a note.");
    return;
  }
  const problems = images.map((f) => [f, imageProblem(f, options)] as const).filter(([, p]) => p);
  for (const [file, problem] of problems) options.onError?.(problem!, file);
  images = images.filter((f) => !problems.some(([bad]) => bad === f));
  if (!images.length) {
    if (problems.length) noticeAt(view, at, problems.length === 1 ? problems[0][1]! : `${problems.length} images couldn't be added: ${problems[0][1]}`);
    return;
  }
  const named = images.map(imageName);
  const placeholders = named.map((f) => `![Uploading ${f.name.replace(/[[\]]/g, "")}…]()`);
  const ids = named.map(() => nextId++);
  const state = view.state;
  const from = at;
  const to = at === state.selection.main.from ? state.selection.main.to : at;
  const insert = asBlock(state, from, to, placeholders.join("\n\n"));
  const start = from + insert.indexOf(placeholders[0]);
  let offset = start;
  const effects = placeholders.map((p, i) => {
    const span = { from: offset, to: offset + p.length };
    offset += p.length + 2;
    return track.of({ id: ids[i], span });
  });
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    effects,
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  named.forEach((file, i) => {
    upload(file).then(
      (url) => {
        const alt = file.name.replace(/\.\w+$/, "").replace(/[[\]]/g, "");
        replaceTracked(view, ids[i], placeholders[i], `![${alt}](${url.replace(/[()\s]/g, encodeURIComponent)})`);
      },
      (error: unknown) => {
        const span = view.state.field(tracked).get(ids[i]);
        const pos = span?.from ?? view.state.selection.main.head;
        replaceTracked(view, ids[i], placeholders[i], "");
        const reason = error instanceof Error && error.message ? error.message : "Something went wrong.";
        const message = `Couldn't add ${file.name}: ${reason}`;
        options.onError?.(message, file);
        noticeAt(view, Math.min(pos, view.state.doc.length), message);
      },
    );
  });
}

// ---------------------------------------------------------------- handlers

function paste(view: EditorView, event: ClipboardEvent, options: SmartPasteOptions): boolean {
  const data = event.clipboardData;
  if (!data || view.state.readOnly || event.defaultPrevented) return false;
  const text = data.getData("text/plain");
  const html = data.getData("text/html");
  // An image on its own (a screenshot, or one copied from a page). Word and
  // others put a picture of the copied text beside it, which isn't wanted.
  const images = imagesIn(data.files);
  if (images.length && (!text.trim() || /^\s*(<meta[^>]*>\s*)?<img\b[^>]*>\s*$/i.test(html.replace(/<\/?(html|body)[^>]*>|<!--.*?-->/gis, "")))) {
    if (inCode(view.state, view.state.selection.main.from)) return false;
    event.preventDefault();
    insertImages(view, images, view.state.selection.main.from, options);
    return true;
  }
  const plan = planPaste(view.state, { text, html, vscode: data.getData("vscode-editor-data") });
  if (!plan) return false;
  event.preventDefault();
  apply(view, plan, options);
  return true;
}

export function apply(view: EditorView, plan: PastePlan, options: SmartPasteOptions = {}) {
  const id = nextId++;
  const span = { from: plan.from, to: plan.from + plan.insert.length };
  const effects: StateEffect<unknown>[] = [];
  if (plan.label || plan.titleFor) effects.push(track.of({ id, span }));
  if (plan.label) effects.push(setNotice.of({ id, message: plan.label, plain: plan.plain }));
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: span.to },
    effects,
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  if (plan.titleFor && options.linkTitles !== false) {
    const url = plan.titleFor;
    void pageTitle(url).then((title) => {
      if (title && title !== url) replaceTracked(view, id, url, `[${escapeLinkText(title)}](${url})`);
      else view.dispatch({ effects: untrack.of(id) });
    });
  }
}

function drop(view: EditorView, event: DragEvent, options: SmartPasteOptions): boolean {
  const images = imagesIn(event.dataTransfer?.files);
  if (!images.length || view.state.readOnly) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null || inCode(view.state, pos)) return false;
  event.preventDefault();
  insertImages(view, images, pos, options);
  return true;
}

const pasteTheme = EditorView.theme({
  ".cm-tooltip.cm-paste-notice": {
    display: "flex",
    alignItems: "center",
    gap: "0.35rem",
    marginTop: "0.35rem",
    padding: "0.3rem 0.35rem 0.3rem 0.7rem",
    border: "1px solid var(--border)",
    borderRadius: "999px",
    background: "var(--surface)",
    boxShadow: "0 6px 20px rgb(0 0 0 / 0.1)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    color: "var(--muted)",
    whiteSpace: "nowrap",
  },
  ".cm-paste-notice.error": { color: "var(--danger, #c0392b)" },
  ".cm-paste-notice button": {
    border: "0",
    background: "none",
    padding: "0.1rem 0.25rem",
    font: "inherit",
    color: "var(--accent)",
    cursor: "pointer",
    borderRadius: "6px",
  },
  ".cm-paste-notice button:hover": { background: "var(--surface-2)" },
  ".cm-paste-notice button.close": { color: "var(--muted)", fontSize: "15px", lineHeight: "1" },
});

const noticeKeys = keymap.of([
  {
    key: "Escape",
    run: (view) => {
      const notice = view.state.field(noticeField);
      if (!notice) return false;
      dismiss(view, notice.id);
      return true;
    },
  },
]);

/** Smart paste and image drop. Add it to an editable Markdown editor. */
export function smartPaste(options: SmartPasteOptions = {}): Extension {
  return [
    tracked,
    noticeField,
    noticeTooltip,
    noticeKeys,
    pasteTheme,
    EditorView.domEventHandlers({
      paste: (event, view) => paste(view, event, options),
      drop: (event, view) => drop(view, event, options),
    }),
  ];
}
