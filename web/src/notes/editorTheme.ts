import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { highlightTag } from "./highlightSyntax";

// The writing surface: no gutters, the app's colours, serif headings, and
// Markdown punctuation dimmed so the words stand out.

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text)",
    backgroundColor: "transparent",
    fontSize: "15px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.7",
  },
  ".cm-content": {
    maxWidth: "46rem",
    margin: "0 auto",
    padding: "2rem 1.5rem 40vh",
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent) !important",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-ySelectionInfo": {
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    padding: "1px 4px",
    borderRadius: "4px 4px 4px 0",
    opacity: "1",
    top: "-1.35em",
  },
});

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontFamily: "var(--font-serif)", fontSize: "1.6em", fontWeight: "500" },
  { tag: t.heading2, fontFamily: "var(--font-serif)", fontSize: "1.35em", fontWeight: "500" },
  { tag: t.heading3, fontFamily: "var(--font-serif)", fontSize: "1.15em", fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: highlightTag, backgroundColor: "var(--highlight)", borderRadius: "2px" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)", textDecoration: "underline" },
  { tag: t.monospace, color: "var(--code-text)", backgroundColor: "var(--code-bg)", borderRadius: "3px" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  // Code inside fences, coloured by the language's own parser.
  { tag: t.keyword, color: "var(--syntax-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syntax-function)" },
  { tag: [t.typeName, t.className, t.tagName], color: "var(--syntax-type)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--syntax-attr)" },
]);

export const editorHighlighting = syntaxHighlighting(markdownHighlight);
