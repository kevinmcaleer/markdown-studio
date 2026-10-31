import type { MarkdownItInstance } from "./markdown";

// Videos: a block of YouTube links shown as a group of thumbnail cards, in
// the order the lines are written. One video or several, it's the same block;
// adding, removing and reordering videos is adding, deleting and moving lines.
//
//   ::: videos
//   https://www.youtube.com/watch?v=dQw4w9WgXcQ
//   [Wiring it up](https://youtu.be/abcdefghijk)
//   https://youtu.be/abcdefghijk Wiring it up
//   :::
//
// A line's title is its link text, or the words after its address; a video
// without one shows YouTube's own title once it's looked up (the live view
// does this). Lines without a YouTube link are left out. The preview
// (videosPlugin) and the live view (videosWidget.ts) both draw videosHtml,
// which videos.css styles; a host can draw the cards its own way instead
// (the `videoRenderer` option). kevsrobots' project pages mirror this file.

export type Video = { id: string; title: string };

/** `::: videos`, alone on a line. */
export const VIDEOS_OPEN = /^[ \t]{0,3}:::[ \t]*videos?[ \t]*$/i;
/** The `:::` that closes a block. */
export const VIDEOS_CLOSE = /^[ \t]{0,3}:::[ \t]*$/;

/** The opening line. */
export const videosOpenLine = "::: videos";

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** The id of a YouTube video from its address (watch, youtu.be, embed, shorts) or the id itself; null otherwise. */
export function youTubeId(text: string): string | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  if (YT_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let candidate: string | null = null;
  if (host === "youtu.be") candidate = url.pathname.replace(/^\//, "").split("/", 1)[0];
  else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const path = url.pathname;
    if (path === "/watch" || path.startsWith("/watch/")) candidate = url.searchParams.get("v");
    else {
      const match = /^\/(?:embed|shorts|v|live)\/([^/]+)/.exec(path);
      candidate = match ? match[1] : null;
    }
  }
  return candidate && YT_ID.test(candidate) ? candidate : null;
}

/** A video's watch address. */
export function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** A video's thumbnail (320×180). */
export function videoThumbnail(id: string): string {
  return `https://img.youtube.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
}

const LINK = /\[((?:\\.|[^\]\\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/;
const URL_IN_TEXT = /<?(https?:\/\/[^\s<>]+|(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s<>]+)>?/i;

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|"'<>~])/g, "$1");
}

/** A title's text without emphasis marks, list bullets or separators. */
function cleanTitle(text: string): string {
  return unescapeMarkdown(text.replace(/[*_`~]+/g, ""))
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, "")
    .trim();
}

/** The video on one line of a block, or null when it has no YouTube link. */
export function videoFromLine(line: string): Video | null {
  const link = LINK.exec(line);
  if (link) {
    const id = youTubeId(link[2]);
    if (id) {
      const label = cleanTitle(link[1]);
      const rest = cleanTitle(line.replace(link[0], " "));
      // `[https://…](https://…)` has no title of its own.
      return { id, title: youTubeId(label) ? rest : label || rest };
    }
  }
  const bare = URL_IN_TEXT.exec(line);
  if (!bare) return null;
  const id = youTubeId(bare[1]);
  return id ? { id, title: cleanTitle(line.replace(bare[0], " ")) } : null;
}

/** The videos in a block's lines, in order. */
export function videoItems(body: string): Video[] {
  return body.split("\n").flatMap((line) => {
    const video = videoFromLine(line);
    return video ? [video] : [];
  });
}

/** A block's line for a video: its address, then its title if it has one. */
export function videoLine(video: { id: string; title?: string | null }): string {
  const title = (video.title ?? "").replace(/\s+/g, " ").trim();
  return title ? `${videoUrl(video.id)} ${title}` : videoUrl(video.id);
}

export type VideosBlock = {
  /** Line numbers (0-based) of the `::: videos` line and its `:::`. */
  open: number;
  close: number;
  videos: Video[];
};

/** The closed `::: videos` blocks in some lines of Markdown, skipping fenced code. */
export function findVideoBlocks(lines: readonly string[]): VideosBlock[] {
  const blocks: VideosBlock[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (!VIDEOS_OPEN.test(line)) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (VIDEOS_CLOSE.test(lines[j])) {
        close = j;
        break;
      }
      if (/^[ \t]{0,3}:::/.test(lines[j])) break;
    }
    if (close < 0) continue;
    blocks.push({ open: i, close, videos: videoItems(lines.slice(i + 1, close).join("\n")) });
    i = close;
  }
  return blocks;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The title shown for a video without one, until YouTube's is looked up. */
export const untitledVideo = "YouTube video";

/**
 * Videos as HTML, a card each:
 *
 *   <div class="md-videos" data-video-count="2">
 *     <a class="md-video" href="https://www.youtube.com/watch?v=…" data-video-id="…">
 *       <span class="md-video-thumb"><img …><span class="md-video-play"></span></span>
 *       <span class="md-video-title">…</span>
 *     </a> …
 *   </div>
 */
export function videosHtml(videos: readonly Video[]): string {
  const cards = videos
    .map((video) => {
      const id = escapeHtml(video.id);
      const title = escapeHtml(video.title || untitledVideo);
      return (
        `<a class="md-video" href="${escapeHtml(videoUrl(video.id))}" target="_blank" rel="noopener noreferrer" data-video-id="${id}"${video.title ? "" : " data-video-untitled"}>` +
        `<span class="md-video-thumb"><img src="${escapeHtml(videoThumbnail(video.id))}" alt="" loading="lazy"><span class="md-video-play" aria-hidden="true"></span></span>` +
        `<span class="md-video-title">${title}</span></a>`
      );
    })
    .join("");
  return `<div class="md-videos${videos.length ? "" : " md-videos-empty"}" data-video-count="${videos.length}">${cards}</div>`;
}

const titles = new Map<string, Promise<string>>();

/** YouTube's title for a video (its oEmbed), or "" when it can't be had. Asked once per video. */
export function lookUpVideoTitle(id: string): Promise<string> {
  let title = titles.get(id);
  if (!title) {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl(id))}`;
    title = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { title?: string } | null) => data?.title ?? "")
      .catch(() => "");
    titles.set(id, title);
  }
  return title;
}

/** Fills in YouTube's titles for the cards under `root` that have none. */
export function fillVideoTitles(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".md-video[data-video-untitled]").forEach((card) => {
    const id = card.dataset.videoId;
    if (!id) return;
    void lookUpVideoTitle(id).then((title) => {
      const label = card.querySelector(".md-video-title");
      if (title && label) label.textContent = title;
    });
  });
}

/** markdown-it: `::: videos` … `:::` as a group of video cards (videosHtml). */
export function videosPlugin(md: MarkdownItInstance): void {
  md.block.ruler.before(
    "fence",
    "videos",
    (state, startLine, endLine, silent) => {
      const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      if (!VIDEOS_OPEN.test(lineText(startLine))) return false;
      let close = -1;
      for (let n = startLine + 1; n < endLine; n++) {
        if (state.sCount[n] < state.blkIndent) break;
        const text = lineText(n);
        if (VIDEOS_CLOSE.test(text)) {
          close = n;
          break;
        }
        if (/^:::/.test(text)) break;
      }
      if (close < 0) return false;
      if (silent) return true;
      const body: string[] = [];
      for (let n = startLine + 1; n < close; n++) body.push(state.src.slice(state.bMarks[n], state.eMarks[n]));
      const token = state.push("videos", "div", 0);
      token.block = true;
      token.content = body.join("\n");
      token.map = [startLine, close + 1];
      state.line = close + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
  md.renderer.rules.videos = (tokens, i) => videosHtml(videoItems(tokens[i].content)) + "\n";
}
