import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import taskLists from "markdown-it-task-lists";
import { calloutPlugin } from "./callouts";
import "./callouts.css";
import "./prose.css";

// The preview renderer. Raw HTML in a note is shown as text rather than run
// (html: false), and markdown-it refuses javascript: links, so the output is
// safe to put in the page as-is.

function highlight(code: string, lang: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  const html = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
  return `<pre class="hljs"><code${language ? ` class="language-${language}"` : ""}>${html}</code></pre>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A markdown-it set up the way notes render: GFM, footnotes, ==highlight==,
 * task lists, callouts and highlighted code. `configure` can add plugins or change
 * options (a host's `preview.markdownIt`); it can't turn raw HTML back on
 * without the host meaning to, since that's its own option.
 */
export type MarkdownItInstance = InstanceType<typeof MarkdownIt>;

export function createMarkdownIt(configure?: (md: MarkdownItInstance) => MarkdownItInstance | void): MarkdownItInstance {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true, highlight })
    .use(mark)
    .use(footnote)
    .use(taskLists, { enabled: false, label: true })
    .use(calloutPlugin);

  // Links open in a new tab, so following one never loses the note you're on.
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const href = String(tokens[i].attrGet("href") ?? "");
    if (!href.startsWith("#")) {
      tokens[i].attrSet("target", "_blank");
      tokens[i].attrSet("rel", "noopener noreferrer");
    }
    return defaultLinkOpen(tokens, i, options, env, self);
  };
  return configure?.(md) ?? md;
}

const md = createMarkdownIt();

export function renderMarkdown(source: string): string {
  return md.render(source);
}

/** One line of Markdown (a table cell, say) as inline HTML, with no paragraph around it. */
export function renderInline(source: string): string {
  return md.renderInline(source);
}

/** The note's title: its first heading, or its first line of text. */
export function titleOf(source: string): string {
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(source);
  const text = heading?.[1] ?? source.split("\n").find((line) => line.trim()) ?? "";
  return text.trim().slice(0, 120);
}
