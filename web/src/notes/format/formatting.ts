import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { applyCommand, slashCommands } from "../slashMenu";

// The formatting the toolbar and the selection mini-toolbar apply, as plain
// Markdown edits: inline marks are toggled on the selection (or the word under
// the cursor), block styles on every selected line. Inserts reuse the "/" menu's
// commands so a table or code block comes out the same from either place.

export type Mark = "bold" | "italic" | "strike" | "highlight" | "code";
export type Block = "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "bullet" | "numbered" | "checklist" | "quote";

const MARKS: Record<Mark, { node: string; text: string }> = {
  bold: { node: "StrongEmphasis", text: "**" },
  italic: { node: "Emphasis", text: "*" },
  strike: { node: "Strikethrough", text: "~~" },
  highlight: { node: "Highlight", text: "==" },
  code: { node: "InlineCode", text: "`" },
};

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** The `name` node that holds from..to (strictly around it, for a cursor). */
function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(from, side); node; node = node.parent) {
      if (node.name !== name) continue;
      if (from === to ? node.from < from && node.to > to : node.from <= from && node.to >= to) return node;
    }
  }
  return null;
}

function inNode(state: EditorState, pos: number, pattern: RegExp): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (pattern.test(node.name)) return true;
  }
  return false;
}

// A line's block marker: indentation, then a heading, task, bullet, number or quote.
const PREFIX = /^([ \t]*)(#{1,6}(?:[ \t]+|$)|[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)|[-*+](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$)|>[ \t]?)?/;

function blockOfPrefix(marker: string): Block {
  if (!marker) return "paragraph";
  if (marker.startsWith("#")) return `h${marker.trim().length}` as Block;
  if (marker.startsWith(">")) return "quote";
  if (/^\d/.test(marker)) return "numbered";
  if (/\[[ xX]\]/.test(marker)) return "checklist";
  return "bullet";
}

/** The block style of one line of Markdown. */
export function lineBlock(text: string): Block {
  return blockOfPrefix(PREFIX.exec(text)?.[2] ?? "");
}

/** Lines touched by the selection; a range ending at a line's start doesn't count that line. */
function selectedLines(state: EditorState) {
  const seen = new Set<number>();
  const lines: ReturnType<EditorState["doc"]["line"]>[] = [];
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines.sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------- inline marks

/** Wraps the selection (or the word at the cursor) in the mark, or takes it off when it's already there. */
export function toggleMark(state: EditorState, mark: Mark): TransactionSpec {
  const { node: name, text } = MARKS[mark];
  return {
    ...state.changeByRange((range) => {
      let { from, to } = range;
      if (!range.empty) {
        const picked = state.sliceDoc(from, to);
        from += picked.length - picked.trimStart().length;
        to -= picked.length - picked.trimEnd().length;
        if (to <= from) return { range };
      }
      const inside = enclosing(state, from, to, name);
      if (inside) {
        const open = inside.firstChild;
        const close = inside.lastChild;
        if (!open || !close || open === close || !/Mark$/.test(open.name)) return { range };
        const changes = state.changes([
          { from: open.from, to: open.to },
          { from: close.from, to: close.to },
        ]);
        return { changes, range: EditorSelection.range(changes.mapPos(range.anchor, -1), changes.mapPos(range.head, -1)) };
      }
      if (range.empty) {
        const word = state.wordAt(from);
        if (word && word.from < from && word.to > from) ({ from, to } = word);
        else {
          return { changes: { from, insert: text + text }, range: EditorSelection.cursor(from + text.length) };
        }
      }
      // Across lines, each line's text is wrapped on its own (marks don't span lines in Markdown).
      const segments: [number, number][] = [];
      for (let pos = from; pos <= to; ) {
        const line = state.doc.lineAt(pos);
        let start = Math.max(line.from, from);
        if (start === line.from && pos !== from) start += PREFIX.exec(line.text)?.[0].length ?? 0;
        const end = Math.min(line.to, to);
        const body = state.sliceDoc(start, end);
        const a = start + body.length - body.trimStart().length;
        const b = end - (body.length - body.trimEnd().length);
        if (b > a) segments.push([a, b]);
        pos = line.to + 1;
      }
      if (!segments.length) return { range };
      const changes = state.changes(segments.flatMap(([a, b]) => [{ from: a, insert: text }, { from: b, insert: text }]));
      if (range.empty) return { changes, range: EditorSelection.cursor(changes.mapPos(range.head)) };
      return { changes, range: EditorSelection.range(changes.mapPos(from, 1), changes.mapPos(to, -1)) };
    }),
    scrollIntoView: true,
    userEvent: "input",
  };
}

/** Turns the selection into a link with the URL selected, or inserts a blank one. */
export function insertLink(state: EditorState): TransactionSpec {
  const { from, to } = state.selection.main;
  if (from === to || state.sliceDoc(from, to).includes("\n")) return insertBlock(state, "link");
  const label = state.sliceDoc(from, to);
  const url = /^(https?:\/\/|mailto:)\S+$/i.test(label) ? label : "https://";
  const insert = `[${label}](${url})`;
  const urlFrom = from + label.length + 3;
  return {
    changes: { from, to, insert },
    selection: { anchor: urlFrom, head: urlFrom + url.length },
    scrollIntoView: true,
    userEvent: "input",
  };
}

// ---------------------------------------------------------------- block styles

/** Makes every selected line `block`; when they all already are, makes them plain text again. */
export function setBlock(state: EditorState, block: Block): TransactionSpec {
  let lines = selectedLines(state);
  if (lines.length > 1) lines = lines.filter((l) => l.text.trim());
  if (!lines.length) return {};
  const target = block !== "paragraph" && lines.every((l) => lineBlock(l.text) === block) ? "paragraph" : block;
  // Numbering carries on from a numbered line just above.
  const above = lines[0].number > 1 ? state.doc.line(lines[0].number - 1).text : "";
  const prior = /^[ \t]*(\d{1,9})[.)][ \t]/.exec(above);
  let number = prior ? Number(prior[1]) + 1 : 1;
  const changes = lines.map((line) => {
    const [whole, indent = "", marker = ""] = PREFIX.exec(line.text) ?? [""];
    let insert: string;
    switch (target) {
      case "paragraph":
        insert = /^(bullet|numbered|checklist)$/.test(blockOfPrefix(marker)) ? indent : "";
        break;
      case "bullet":
        insert = `${indent}- `;
        break;
      case "checklist":
        insert = `${indent}- [ ] `;
        break;
      case "numbered":
        insert = `${indent}${number++}. `;
        break;
      case "quote":
        insert = "> ";
        break;
      default:
        insert = `${"#".repeat(Number(target.slice(1)))} `;
    }
    return { from: line.from, to: line.from + whole.length, insert };
  });
  const changeSet = state.changes(changes);
  return { changes: changeSet, selection: state.selection.map(changeSet, 1), scrollIntoView: true, userEvent: "input" };
}

/** How far a list item's text starts from its marker: "- " is 2, "10. " is 4. */
function markerWidth(text: string): number | null {
  const m = /^[ \t]*([-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)/.exec(text);
  if (!m) return null;
  return /^[-*+]/.test(m[1]) ? m[1].replace(/\[[ xX]\][ \t]+$/, "").length : m[1].length;
}

const indentOf = (text: string) => /^[ \t]*/.exec(text)![0].replace(/\t/g, "    ").length;

/**
 * Indents (1) or outdents (-1) the selected lines. A list item nests under the
 * item above it, so it moves by that item's marker width ("- " or "1. "); other
 * lines move by four spaces.
 */
export function shiftLines(state: EditorState, dir: 1 | -1): TransactionSpec {
  const lines = selectedLines(state);
  const changes = lines.map((line) => {
    const current = indentOf(line.text);
    const raw = /^[ \t]*/.exec(line.text)![0].length;
    let next: number;
    const isItem = markerWidth(line.text) !== null;
    if (dir > 0) {
      let step = 4;
      if (isItem) {
        for (let n = line.number - 1; n >= 1; n--) {
          const text = state.doc.line(n).text;
          if (!text.trim()) continue;
          const width = markerWidth(text);
          if (width === null || indentOf(text) < current) break;
          if (indentOf(text) === current) {
            step = width;
            break;
          }
        }
      }
      next = current + step;
    } else {
      next = Math.max(0, current - 4);
      if (isItem) {
        // Back to the indentation of the parent item.
        for (let n = line.number - 1; n >= 1; n--) {
          const text = state.doc.line(n).text;
          if (!text.trim()) continue;
          if (indentOf(text) < current && markerWidth(text) !== null) {
            next = indentOf(text);
            break;
          }
          if (markerWidth(text) === null && indentOf(text) < current) break;
        }
      }
    }
    return { from: line.from, to: line.from + raw, insert: " ".repeat(next) };
  });
  const changeSet = state.changes(changes);
  return { changes: changeSet, selection: state.selection.map(changeSet, 1), userEvent: "input" };
}

// ---------------------------------------------------------------- inserts

export type InsertId = "table" | "code" | "divider" | "image" | "link";

/** One of the "/" menu's inserts, at the cursor; block inserts go below the current line. */
export function insertBlock(state: EditorState, id: InsertId): TransactionSpec {
  const command = slashCommands.find((c) => c.id === id)!;
  const { from, to } = state.selection.main;
  if (id === "code" && from !== to) {
    // A fence around the selected lines.
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to);
    const lead = first.number > 1 && state.doc.line(first.number - 1).text.trim() ? "\n" : "";
    const tail = last.number < state.doc.lines && state.doc.line(last.number + 1).text.trim() ? "\n" : "";
    const langAt = first.from + lead.length + 3;
    return {
      changes: [
        { from: first.from, insert: `${lead}\`\`\`\n` },
        { from: last.to, insert: `\n\`\`\`${tail}` },
      ],
      selection: { anchor: langAt },
      scrollIntoView: true,
      userEvent: "input",
    };
  }
  if (command.block) {
    const line = state.doc.lineAt(to);
    const at = line.text.trim() ? line.to : line.from;
    return { ...applyCommand(state, command, at, at), userEvent: "input" };
  }
  return { ...applyCommand(state, command, from, to), userEvent: "input" };
}

// ---------------------------------------------------------------- what's on

export type Active = {
  block: Block;
  marks: Record<Mark, boolean>;
  /** The cursor is in a fenced or indented code block. */
  codeBlock: boolean;
};

export function activeFormats(state: EditorState): Active {
  const { from, to, head } = state.selection.main;
  const marks = {} as Record<Mark, boolean>;
  for (const mark of Object.keys(MARKS) as Mark[]) marks[mark] = enclosing(state, from, to, MARKS[mark].node) !== null;
  return {
    block: lineBlock(state.doc.lineAt(head).text),
    marks,
    codeBlock: inNode(state, head, /^(FencedCode|CodeBlock)$/),
  };
}

export function sameActive(a: Active | null, b: Active): boolean {
  if (!a || a.block !== b.block || a.codeBlock !== b.codeBlock) return false;
  return (Object.keys(b.marks) as Mark[]).every((m) => a.marks[m] === b.marks[m]);
}

// ---------------------------------------------------------------- running them

export type FormatAction =
  | { mark: Mark }
  | { block: Block }
  | { insert: InsertId }
  | { shift: 1 | -1 };

/** Applies an action to the editor. False when it can't be edited. */
export function runFormat(view: EditorView, action: FormatAction): boolean {
  const state = view.state;
  if (state.readOnly) return false;
  const spec =
    "mark" in action
      ? toggleMark(state, action.mark)
      : "block" in action
        ? setBlock(state, action.block)
        : "shift" in action
          ? shiftLines(state, action.shift)
          : action.insert === "link"
            ? insertLink(state)
            : insertBlock(state, action.insert);
  view.dispatch(spec);
  view.focus();
  return true;
}

const run = (action: FormatAction) => (view: EditorView) => runFormat(view, action);

/** Keyboard shortcuts, matching the toolbar's tooltips. */
export const formatKeymap: Extension = Prec.high(
  keymap.of([
    { key: "Mod-b", run: run({ mark: "bold" }) },
    { key: "Mod-i", run: run({ mark: "italic" }) },
    { key: "Mod-Shift-x", run: run({ mark: "strike" }) },
    { key: "Mod-Shift-h", run: run({ mark: "highlight" }) },
    { key: "Mod-e", run: run({ mark: "code" }) },
    { key: "Mod-k", run: run({ insert: "link" }) },
    { key: "Mod-Alt-0", run: run({ block: "paragraph" }) },
    { key: "Mod-Alt-1", run: run({ block: "h1" }) },
    { key: "Mod-Alt-2", run: run({ block: "h2" }) },
    { key: "Mod-Alt-3", run: run({ block: "h3" }) },
    { key: "Mod-Shift-7", run: run({ block: "numbered" }) },
    { key: "Mod-Shift-8", run: run({ block: "bullet" }) },
    { key: "Mod-Shift-9", run: run({ block: "checklist" }) },
    { key: "Mod-]", run: run({ shift: 1 }) },
    { key: "Mod-[", run: run({ shift: -1 }) },
  ]),
);
