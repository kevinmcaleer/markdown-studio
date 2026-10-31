import { type EditorState, type Range, StateField, type TransactionSpec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

// `#todo` notes to self. A writer leaves `#todo add the wiring photo` where
// something still needs doing; the editor gathers them into a little list at
// the top right, and one click on a todo marks it done, taking the tag and
// its note out of the text. The note runs to the end of the line (or, in a
// table row, to the end of the cell). A `#todo` in code is just text.

export type Todo = {
  /** Where `#todo` starts. */
  from: number;
  /** The end of its note (trailing spaces left out). */
  to: number;
  /** The note after the tag, "" when there isn't one. */
  text: string;
  /** 1-based line number. */
  line: number;
  /** The heading the todo sits under, "" before the first one. */
  section: string;
};

const TAG = /(?<![\w#/&@\\])#todo(?![\w-])/gi;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** Whether `pos` on `text` is inside an inline code span. */
function inCode(text: string, pos: number): boolean {
  let open: string | null = null;
  for (let i = 0; i < pos; i++) {
    if (text[i] === "\\" && !open) {
      i++;
      continue;
    }
    if (text[i] !== "`") continue;
    let run = 1;
    while (text[i + run] === "`") run++;
    const ticks = text.slice(i, i + run);
    if (open === null) open = ticks;
    else if (open === ticks) open = null;
    i += run - 1;
  }
  return open !== null && text.indexOf(open, pos) >= 0;
}

/** Strips heading Markdown that would look odd in a list: emphasis, links, code ticks. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~=]+/g, "")
    .trim();
}

/** Every `#todo` in the Markdown, in order. */
export function findTodos(doc: string): Todo[] {
  const out: Todo[] = [];
  let fence: string | null = null;
  let section = "";
  let pos = 0;
  const lines = doc.split("\n");
  lines.forEach((text, i) => {
    const lineFrom = pos;
    pos += text.length + 1;
    const f = FENCE.exec(text);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !text.slice(f[0].length).trim()) fence = null;
      return;
    }
    if (f) {
      fence = f[1];
      return;
    }
    const heading = HEADING.exec(text);
    if (heading && !/^ {0,3}#todo\b/i.test(text)) section = plain(heading[1].replace(TAG, "")) || section;
    const tableRow = /^\s*\|/.test(text);
    TAG.lastIndex = 0;
    for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
      const at = m.index;
      if (inCode(text, at)) continue;
      const afterTag = at + m[0].length;
      // The note ends at the line's end, the next #todo, or (in a table) the cell's end.
      let end = text.length;
      TAG.lastIndex = afterTag;
      const next = TAG.exec(text);
      if (next) end = next.index;
      if (tableRow) {
        let pipe = afterTag;
        while ((pipe = text.indexOf("|", pipe)) >= 0 && text[pipe - 1] === "\\") pipe++;
        if (pipe >= 0 && pipe < end) end = pipe;
      }
      TAG.lastIndex = next ? next.index : text.length;
      const rest = text.slice(afterTag, end);
      const trimmedEnd = afterTag + rest.trimEnd().length;
      const note = rest.replace(/^\s*[:\-–—]?\s*/, "").trim();
      out.push({ from: lineFrom + at, to: lineFrom + trimmedEnd, text: note, line: i + 1, section });
    }
  });
  return out;
}

/**
 * The change that marks `todo` done: the tag and its note go, and a line
 * left with nothing on it goes too.
 */
export function completeTodo(state: EditorState, todo: Todo): TransactionSpec | null {
  // The document may have moved on since the list was drawn: find it again.
  const all = findTodos(state.doc.toString());
  const current =
    all.find((t) => t.from === todo.from && t.text === todo.text) ??
    all.find((t) => t.line === todo.line && t.text === todo.text) ??
    all.find((t) => t.text === todo.text);
  if (!current) return null;
  const line = state.doc.lineAt(current.from);
  const before = state.sliceDoc(line.from, current.from);
  const after = state.sliceDoc(current.to, line.to);
  let from = current.from;
  let to = current.to;
  const marker = /^\s*(?:[-*+] \[[ xX]\]|[-*+]|\d+[.)]|>)?\s*$/;
  if (marker.test(before) && !after.trim()) {
    // A line of its own: take the whole line with it.
    if (line.number < state.doc.lines) {
      from = line.from;
      to = line.to + 1;
    } else if (line.number > 1) {
      from = line.from - 1;
      to = line.to;
    } else {
      from = line.from;
      to = line.to;
    }
  } else {
    // Take the space before the tag too, so no double space is left behind.
    const space = /[ \t]+$/.exec(before);
    if (space) from -= space[0].length;
    // The tag starting the line ("#todo fix this" then more text): eat the space after instead.
    else if (/^[ \t]+/.test(after)) to += /^[ \t]+/.exec(after)![0].length;
    // A list item or quote marker keeps one space before what's left.
    if (marker.test(before) && before.trim() && space) from += 1;
  }
  return {
    changes: { from, to },
    selection: { anchor: Math.min(from, state.doc.length - (to - from)) },
    userEvent: "delete.todo",
    scrollIntoView: false,
  };
}

// ---------------------------------------------------------------- the live view

const tagMark = Decoration.mark({ class: "cm-todo-tag", attributes: { title: "To do: listed in the todo list at the top right" } });
const noteMark = Decoration.mark({ class: "cm-todo-note" });

function decorate(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const todo of findTodos(state.doc.toString())) {
    out.push(tagMark.range(todo.from, todo.from + 5));
    if (todo.to > todo.from + 5) out.push(noteMark.range(todo.from + 5, todo.to));
  }
  return Decoration.set(out, true);
}

/** `#todo` drawn as a tag, with its note underlined, in the live view. */
export const todoMarks = StateField.define<DecorationSet>({
  create: decorate,
  update: (marks, tr) => (tr.docChanged ? decorate(tr.state) : marks),
  provide: (field) => EditorView.decorations.from(field),
});
