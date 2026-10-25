// Rich text from the clipboard (web pages, Word, Google Docs, email) as
// Markdown: headings, emphasis, lists, links, tables, quotes and code. Anything
// else keeps its text and loses its formatting. Images only come through when
// they're on the web or already stored here; a data: or file: image would
// either bloat the note or point nowhere.

const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "summary", "table", "ul",
]);
const SKIP = new Set(["head", "script", "style", "template", "noscript", "meta", "link", "title", "button", "input", "select", "textarea", "svg", "o:p"]);
const MONOSPACE = /\b(monospace|courier|consolas|menlo|monaco|jetbrains|fira code|source code|sf mono|cascadia|roboto mono|ubuntu mono)\b/i;

type Context = { bold: boolean; italic: boolean; strike: boolean; code: boolean; table: boolean };
const PLAIN: Context = { bold: false, italic: false, strike: false, code: false, table: false };

/** The clipboard's HTML as Markdown. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  wordLists(doc.body);
  return tidy(blocks(doc.body, PLAIN));
}

/** The language a code block names in its class (language-x, lang-x, highlight-source-x, brush: x). */
export function codeLanguage(el: Element | null): string {
  for (let node = el; node && node.tagName !== "BODY"; node = node.parentElement) {
    const cls = `${node.getAttribute("class") ?? ""} ${node.getAttribute("data-lang") ? `language-${node.getAttribute("data-lang")}` : ""}`;
    const match = /(?:^|\s)(?:language|lang|highlight-source|sourceCode)-([\w+#-]+)/.exec(cls) ?? /brush:\s*([\w+#-]+)/.exec(cls);
    if (match) return match[1].toLowerCase();
  }
  return "";
}

// ---------------------------------------------------------------- blocks

function tag(node: Node): string {
  return node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";
}

function style(el: Element, prop: string): string {
  const css = (el.getAttribute("style") ?? "").toLowerCase();
  const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(css);
  return match ? match[1].trim() : "";
}

function isBlock(node: Node): boolean {
  return BLOCKS.has(tag(node)) || isCodeBlock(node);
}

/** A <pre>, or the monospace, whitespace-keeping box that VS Code and others put copied code in. */
function isCodeBlock(node: Node): boolean {
  if (tag(node) === "pre") return true;
  if (tag(node) !== "div") return false;
  const el = node as Element;
  return /^pre/.test(style(el, "white-space")) && MONOSPACE.test(style(el, "font-family"));
}

function holdsBlocks(node: Node): boolean {
  return node.nodeType === 1 && Array.from((node as Element).querySelectorAll("*")).some(isBlock);
}

/** A run of children as Markdown blocks, with inline content between blocks made into paragraphs. */
function blocks(parent: Node, ctx: Context): string {
  const out: string[] = [];
  let run = "";
  const flush = () => {
    const text = paragraph(run);
    if (text) out.push(text);
    run = "";
  };
  for (const child of Array.from(parent.childNodes)) {
    if (SKIP.has(tag(child))) continue;
    if (isBlock(child)) {
      flush();
      const block = blockOf(child as Element, ctx);
      if (block) out.push(block);
    } else if (holdsBlocks(child)) {
      // An inline element around blocks (Google Docs wraps everything in a <b>) is just a container.
      flush();
      const inner = blocks(child, ctx);
      if (inner) out.push(inner);
    } else run += inline(child, ctx);
  }
  flush();
  return out.join("\n\n");
}

function paragraph(text: string): string {
  return text
    .split("\n")
    .map((line) => escapeLineStart(line.replace(/[ \t]+/g, " ").trim()))
    .filter((line, i, lines) => line || (i > 0 && lines[i - 1]))
    .join("\n")
    .trim()
    // A hard break at the very end or start of a paragraph means nothing.
    .replace(/^\\\n|\\$/g, "");
}

function blockOf(el: Element, ctx: Context): string {
  if (isCodeBlock(el)) return fence(codeText(el), codeLanguage(el.querySelector("code") ?? el));
  const name = tag(el);
  switch (name) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = inline(el, { ...ctx, bold: true }).replace(/\s+/g, " ").trim();
      return text ? `${"#".repeat(Number(name[1]))} ${text}` : "";
    }
    case "p":
      // Google Docs and Word mark headings by role or class as often as by tag.
      if (/^Heading([1-6])$|^MsoHeading([1-6])$/.test(el.getAttribute("class") ?? "")) {
        const level = /([1-6])$/.exec(el.getAttribute("class")!)![1];
        return `${"#".repeat(Number(level))} ${inline(el, ctx).replace(/\s+/g, " ").trim()}`;
      }
      if (MONOSPACE.test(style(el, "font-family")) && !el.querySelector("*:not(span):not(br)")) {
        return fence(codeText(el), "");
      }
      return paragraph(inlineChildren(el, ctx));
    case "hr":
      return "---";
    case "blockquote": {
      const inner = blocks(el, ctx);
      return inner ? inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") : "";
    }
    case "ul":
    case "ol":
      return list(el, ctx);
    case "li":
      // An item outside a list (a fragment of one was copied).
      return item(el, "- ", ctx);
    case "table":
      return table(el, ctx);
    case "dt":
      return `**${inlineChildren(el, ctx).trim()}**`;
    default:
      return blocks(el, ctx);
  }
}

function list(el: Element, ctx: Context): string {
  const ordered = tag(el) === "ol";
  let n = Number(el.getAttribute("start") ?? 1) || 1;
  const items: string[] = [];
  for (const child of Array.from(el.children)) {
    if (tag(child) === "li") items.push(item(child, ordered ? `${n++}. ` : "- ", ctx));
    else if (tag(child) === "ul" || tag(child) === "ol") {
      // Some editors nest a list directly in a list: it belongs to the item before.
      const nested = indent(list(child, ctx), ordered ? "   " : "  ");
      if (items.length) items[items.length - 1] += `\n${nested}`;
      else items.push(nested);
    }
  }
  return items.join("\n");
}

function item(li: Element, marker: string, ctx: Context): string {
  // Paragraphs in an item (Google Docs puts every item in one) read as lines of it.
  const parts: string[] = [];
  let run = "";
  for (const child of Array.from(li.childNodes)) {
    if (SKIP.has(tag(child))) continue;
    if (tag(child) === "p" || tag(child) === "div") {
      run += (run.trim() ? "\n" : "") + inlineChildren(child as Element, ctx);
    } else if (isBlock(child)) {
      if (run.trim()) parts.push(paragraph(run));
      run = "";
      const block = blockOf(child as Element, ctx);
      if (block) parts.push(block);
    } else run += inline(child, ctx);
  }
  if (run.trim()) parts.push(paragraph(run));
  let body = parts.join("\n");
  // A checkbox makes it a task.
  const box = li.querySelector('input[type="checkbox"]');
  if (box && !body.startsWith("[")) body = `[${box.hasAttribute("checked") ? "x" : " "}] ${body}`;
  const pad = " ".repeat(marker.length);
  return marker + body.split("\n").map((line, i) => (i === 0 || !line ? line : pad + line)).join("\n");
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function table(el: Element, ctx: Context): string {
  const rows = Array.from(el.querySelectorAll("tr")).filter((tr) => tr.closest("table") === el);
  const grid = rows.map((tr) => {
    const cells: string[] = [];
    for (const cell of Array.from(tr.children)) {
      if (tag(cell) !== "td" && tag(cell) !== "th") continue;
      const text = cellText(cell, ctx);
      const span = Math.max(1, Math.min(50, Number(cell.getAttribute("colspan")) || 1));
      cells.push(text, ...Array(span - 1).fill(""));
    }
    return cells;
  });
  const width = Math.max(0, ...grid.map((r) => r.length));
  // A table with one cell, or one used for layout, is just its content.
  if (!grid.length || width < 2 || el.querySelector("table")) return blocks(el, ctx);
  for (const row of grid) while (row.length < width) row.push("");
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(grid[0]), line(grid[0].map(() => "---")), ...grid.slice(1).map(line)].join("\n");
}

function cellText(cell: Element, ctx: Context): string {
  return inlineChildren(cell, { ...ctx, table: true })
    .replace(/\\\n|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<!\\)\|/g, "\\|");
}

// ---------------------------------------------------------------- inline

function inlineChildren(el: Node, ctx: Context): string {
  let text = "";
  for (const child of Array.from(el.childNodes)) {
    if (SKIP.has(tag(child))) continue;
    // A block inside inline content (a <div> in a table cell, say) starts a new line.
    if (isBlock(child)) {
      const inner = inlineChildren(child, ctx).trim();
      if (inner) text += (text && !text.endsWith("\n") ? "\n" : "") + inner + "\n";
    } else text += inline(child, ctx);
  }
  return text;
}

function inline(node: Node, ctx: Context): string {
  if (node.nodeType === 3) {
    const text = (node.textContent ?? "").replace(/[\s ]+/g, " ");
    return ctx.code ? text : escapeInline(text);
  }
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const name = tag(el);
  if (SKIP.has(name)) return "";
  if (name === "br") return ctx.table ? " " : "\\\n";
  if (name === "img") return image(el);
  if (name === "a") return link(el, ctx);
  if (["code", "kbd", "samp", "tt"].includes(name) || (!ctx.code && MONOSPACE.test(style(el, "font-family")))) {
    return ctx.code ? el.textContent ?? "" : code(el.textContent ?? "");
  }
  // Google Docs wraps the whole paste in <b style="font-weight:normal">.
  const weight = style(el, "font-weight");
  const bold = weight ? weight === "bold" || weight === "bolder" || Number(weight) >= 600 : name === "b" || name === "strong";
  const italic = name === "em" || name === "i" || name === "cite" || style(el, "font-style") === "italic";
  const strike = name === "s" || name === "del" || name === "strike" || style(el, "text-decoration").includes("line-through");
  const marked = name === "mark";
  const inner = { ...ctx, bold: ctx.bold || bold, italic: ctx.italic || italic, strike: ctx.strike || strike };
  let text = inlineChildren(el, inner);
  if (marked) text = wrap(text, "==");
  if (strike && !ctx.strike) text = wrap(text, "~~");
  if (italic && !ctx.italic) text = wrap(text, "*");
  if (bold && !ctx.bold) text = wrap(text, "**");
  return text;
}

/** Puts `mark` either side of the text, keeping its outer spaces outside (`** x**` isn't bold). */
function wrap(text: string, mark: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2] ? `${match[1]}${mark}${match[2]}${mark}${match[3]}` : text;
}

function link(el: Element, ctx: Context): string {
  const href = (el.getAttribute("href") ?? "").trim();
  const text = inlineChildren(el, ctx).replace(/\s+/g, " ").trim();
  if (!/^(https?:|mailto:|#|\/)/i.test(href)) return text;
  if (!text) return "";
  if (text === href || text === escapeInline(href)) return `<${href}>`;
  return `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
}

function image(el: Element): string {
  const src = (el.getAttribute("src") ?? "").trim();
  const alt = escapeInline((el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim());
  if (!/^(https?:|\/)/i.test(src)) return alt;
  return `![${alt}](${src.replace(/[()\s]/g, encodeURIComponent)})`;
}

function code(text: string): string {
  const value = text.replace(/[\s ]+/g, " ");
  if (!value.trim()) return value;
  const ticks = Math.max(0, ...(value.match(/`+/g) ?? []).map((t) => t.length)) + 1;
  const fenceMark = "`".repeat(ticks);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fenceMark}${pad}${value}${pad}${fenceMark}`;
}

/** A fenced code block, with a fence longer than any run of backticks inside. */
export function fence(text: string, language: string): string {
  const body = text.replace(/ /g, " ").replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  if (!body) return "";
  const ticks = Math.max(2, ...(body.match(/^`+/gm) ?? []).map((t) => t.length)) + 1;
  const mark = "`".repeat(ticks);
  return `${mark}${language}\n${body}\n${mark}`;
}

/** The text of a code block, with <br> and line <div>s as new lines. */
function codeText(el: Node): string {
  let text = "";
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) text += child.textContent ?? "";
    else if (tag(child) === "br") text += "\n";
    else if (child.nodeType === 1) {
      const inner = codeText(child);
      text += BLOCKS.has(tag(child)) && text && !text.endsWith("\n") ? `\n${inner}` : inner;
      if (BLOCKS.has(tag(child)) && !inner.endsWith("\n")) text += "\n";
    }
  }
  return text;
}

// ---------------------------------------------------------------- escaping

function escapeInline(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([`*[\]]|==|~~|<(?=[a-z/!]))/gi, (m) => (m.length === 2 ? `\\${m[0]}\\${m[1]}` : `\\${m}`))
    // An underscore only needs it where it could start or end emphasis, not in snake_case.
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace("_", "\\_"));
}

/** Text at the start of a line that would otherwise read as a heading, quote or list. */
function escapeLineStart(line: string): string {
  return line.replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s)/, (m) => (/^\d/.test(m) ? m.replace(/([.)])/, "\\$1") : `\\${m}`));
}

/** Blank lines between blocks at most one, and none at either end. */
function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- Word

/**
 * Word's HTML has no lists: each item is a paragraph styled `mso-list: l0 level2`
 * with its bullet as text in a span. This turns runs of those into real lists.
 */
function wordLists(body: HTMLElement) {
  const doc = body.ownerDocument;
  const items = Array.from(body.querySelectorAll("p")).filter((p) => /mso-list:\s*l\d+\s+level\d/i.test(p.getAttribute("style") ?? ""));
  let stack: { level: number; list: HTMLElement }[] = [];
  let last: Element | null = null;
  for (const p of items) {
    const level = Number(/level(\d+)/i.exec(p.getAttribute("style")!)![1]);
    const bullets = Array.from(p.querySelectorAll("span")).filter((s) => /mso-list:\s*ignore/i.test(s.getAttribute("style") ?? ""));
    const marker = bullets.map((s) => s.textContent ?? "").join("").trim();
    bullets.forEach((s) => s.remove());
    // Word's "conditional comment" bullets come through as text too.
    for (const n of Array.from(p.childNodes)) if (n.nodeType === 8) n.remove();
    const ordered = /^[\w]{1,4}[.)]$/.test(marker);
    if (p.previousElementSibling !== last) stack = [];
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.level < level) {
      const list = doc.createElement(ordered ? "ol" : "ul");
      if (top) (top.list.lastElementChild ?? top.list).append(list);
      else p.before(list);
      top = { level, list };
      stack.push(top);
    }
    const li = doc.createElement("li");
    li.append(...Array.from(p.childNodes));
    top.list.append(li);
    last = stack[0].list;
    p.remove();
  }
}
