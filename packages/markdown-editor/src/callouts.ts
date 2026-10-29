import type { MarkdownItInstance } from "./markdown";

// Obsidian's callouts: a quote whose first line is `[!type]`, with an
// optional title after it and an optional + or - that makes it foldable
// (open or closed to start with).
//
//   > [!warning]- Mind the mains
//   > Unplug it before you open the case.
//
// Unknown types still render, as a note. GitHub's alerts (`> [!NOTE]`) are
// the same syntax, so they work too.

export type CalloutKind = {
  type: string;
  label: string;
  aliases: string[];
  /** Its colour, as "r g b" (callouts.css has the same). */
  color: string;
  /** 24×24 stroke icon path (callouts.css carries it as a mask). */
  icon: string;
};

/** The standard types, each with the names Obsidian also accepts for it. */
export const calloutKinds: CalloutKind[] = [
  { type: "note", label: "Note", aliases: [], color: "8 109 221", icon: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" },
  {
    type: "abstract",
    label: "Abstract",
    aliases: ["summary", "tldr"],
    color: "0 191 188",
    icon: "M9 2h6v4H9zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 12h6M9 16h6",
  },
  { type: "info", label: "Info", aliases: ["information"], color: "8 109 221", icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01" },
  { type: "todo", label: "Todo", aliases: [], color: "8 109 221", icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9 12l2 2 4-4" },
  {
    type: "tip",
    label: "Tip",
    aliases: ["hint", "important"],
    color: "0 191 188",
    icon: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z",
  },
  { type: "success", label: "Success", aliases: ["check", "done"], color: "8 185 78", icon: "M20 6 9 17l-5-5" },
  {
    type: "question",
    label: "Question",
    aliases: ["help", "faq"],
    color: "236 117 0",
    icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  },
  {
    type: "warning",
    label: "Warning",
    aliases: ["caution", "attention", "alert"],
    color: "236 117 0",
    icon: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  },
  { type: "failure", label: "Failure", aliases: ["fail", "missing"], color: "233 49 71", icon: "M18 6 6 18M6 6l12 12" },
  { type: "danger", label: "Danger", aliases: ["error"], color: "233 49 71", icon: "M13 2 3 14h9l-1 8 10-12h-9l1-8z" },
  {
    type: "bug",
    label: "Bug",
    aliases: [],
    color: "233 49 71",
    icon: "M9 7.1V6a3 3 0 1 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6 13H2M22 13h-4M6.5 9C4.6 8.8 3 7.1 3 5M17.5 9c1.9-.2 3.5-1.9 3.5-4M6.8 17C4.7 17.1 3 18.9 3 21M17.2 17c2.1.1 3.8 1.9 3.8 4",
  },
  { type: "example", label: "Example", aliases: [], color: "120 82 238", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  {
    type: "quote",
    label: "Quote",
    aliases: ["cite"],
    color: "158 158 158",
    icon: "M3 21c3 0 7-1 7-8V5c0-1.25-.76-2-2-2H4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h3c0 2.5-1 4-4 4zM14 21c3 0 7-1 7-8V5c0-1.25-.76-2-2-2h-4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h3c0 2.5-1 4-4 4z",
  },
];

const byName = new Map(calloutKinds.flatMap((kind) => [kind.type, ...kind.aliases].map((name) => [name, kind] as const)));

/** `[!type]`, then + or -, then the title, at the start of a quote's first line. */
export const CALLOUT_HEADER = /^\[!([\w-]+)\]([+-]?)(?:[ \t]+(.*))?$/;

export type CalloutHeader = {
  /** The standard type it styles as ("note" for one we don't know). */
  type: string;
  /** What was written, lower-cased: an alias, or a custom type. */
  name: string;
  /** "+" starts open, "-" starts closed, "" isn't foldable. */
  fold: "" | "+" | "-";
  /** The title as written, or the type's name when there isn't one. */
  title: string;
  /** Whether a title was written. */
  titled: boolean;
};

/** Reads a callout's first line (without its `>`), or null when it isn't one. */
export function parseCalloutHeader(line: string): CalloutHeader | null {
  const match = CALLOUT_HEADER.exec(line.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const kind = byName.get(name);
  const written = (match[3] ?? "").trim();
  const fallback = kind?.label ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");
  return { type: kind?.type ?? "note", name, fold: match[2] as CalloutHeader["fold"], title: written || fallback, titled: !!written };
}

/**
 * The markdown-it plugin. A callout renders as
 *
 *   <div class="callout callout-warning" data-callout="warning">
 *     <div class="callout-title"><span class="callout-icon" aria-hidden="true"></span><span class="callout-title-text">…</span></div>
 *     <div class="callout-content">…</div>
 *   </div>
 *
 * and a foldable one as <details>/<summary> in place of the outer div and
 * the title, so it opens and closes with no script.
 */
export function calloutPlugin(md: MarkdownItInstance): void {
  md.core.ruler.after("block", "callouts", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (open.type !== "blockquote_open" || tokens[i + 1]?.type !== "paragraph_open" || tokens[i + 2]?.type !== "inline") continue;
      const inline = tokens[i + 2];
      const newline = inline.content.indexOf("\n");
      const first = newline < 0 ? inline.content : inline.content.slice(0, newline);
      const header = parseCalloutHeader(first);
      if (!header) continue;

      let close = i + 1;
      while (close < tokens.length && !(tokens[close].type === "blockquote_close" && tokens[close].level === open.level)) close++;
      if (close >= tokens.length) continue;

      const tag = header.fold ? "details" : "div";
      open.tag = tokens[close].tag = tag;
      open.attrSet("class", `callout callout-${header.type}`);
      open.attrSet("data-callout", header.name);
      if (header.fold) open.attrSet("data-callout-fold", header.fold);
      if (header.fold === "+") open.attrSet("open", "");

      const make = (type: string, tag: string, nesting: 1 | -1, className?: string) => {
        const token = new state.Token(type, tag, nesting);
        if (className) token.attrSet("class", className);
        token.block = true;
        return token;
      };
      const titleTag = header.fold ? "summary" : "div";
      const title = new state.Token("inline", "", 0);
      title.content = header.title;
      title.map = inline.map;
      title.children = [];
      const titleTokens = [
        make("callout_title_open", titleTag, 1, "callout-title"),
        title,
        make("callout_title_close", titleTag, -1),
        make("callout_content_open", "div", 1, "callout-content"),
      ];

      // The header line is the title now; drop the paragraph when it was all there was.
      const rest = newline < 0 ? "" : inline.content.slice(newline + 1);
      let removed = 0;
      if (rest.trim()) inline.content = rest;
      else {
        tokens.splice(i + 1, 3);
        removed = 3;
      }
      tokens.splice(close - removed, 0, make("callout_content_close", "div", -1));
      tokens.splice(i + 1, 0, ...titleTokens);
    }
  });

  // The title's tag carries the icon and a span for the text, so a host's CSS can style either.
  md.renderer.rules.callout_title_open = (tokens, i, options, _env, self) =>
    self.renderToken(tokens, i, options).trimEnd() + '<span class="callout-icon" aria-hidden="true"></span><span class="callout-title-text">';
  md.renderer.rules.callout_title_close = (tokens, i, options, _env, self) => "</span>" + self.renderToken(tokens, i, options);
}
