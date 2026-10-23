import hljs from "highlight.js/lib/common";
import type { CSSProperties, ReactNode } from "react";
import { withShare } from "../notes/filesApi";
import type { Block, Run, Slide } from "./deck";
import "./decks.css";
import { bodySize, codePt, imageColumn, titleSize } from "./layout";

// One slide, drawn from the deck model with the same geometry as the
// PowerPoint export (layout.ts). Every size is in container units, so the
// same component works as a thumbnail, the editor preview and full screen.

export function SlideView({ slide, className = "" }: { slide: Slide; className?: string }) {
  const big = slide.layout === "title" || slide.layout === "section";
  const style = {
    "--pt": bodySize(slide),
    "--title-pt": slide.title === null ? 0 : titleSize(slide, big),
    "--code-pt": codePt(bodySize(slide)),
  } as CSSProperties;
  const images = slide.blocks.filter((b) => b.type === "image");
  const text = slide.blocks.filter((b) => b.type !== "image");
  return (
    <div className={`slide layout-${slide.layout} ${imageColumn(slide) ? "with-images" : ""} ${className}`} style={style}>
      <div className="slide-inner">
        {slide.title !== null && (
          <h2 className="slide-title">
            <Runs runs={slide.titleRuns} />
          </h2>
        )}
        {(text.length > 0 || images.length > 0) && (
          <div className="slide-body">
            {text.length > 0 && (
              <div className="slide-text">
                <Blocks blocks={text} />
              </div>
            )}
            {images.length > 0 && (
              <div className="slide-images">
                <Blocks blocks={images} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((block, i) => <BlockView key={i} block={block} />);
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "paragraph":
      return (
        <p>
          <Runs runs={block.runs} />
        </p>
      );
    case "quote":
      return (
        <blockquote>
          <Runs runs={block.runs} />
        </blockquote>
      );
    case "bullets":
      return <List items={block.items} />;
    case "code": {
      const language = block.lang && hljs.getLanguage(block.lang) ? block.lang : null;
      return (
        <pre className="hljs">
          {language ? <code dangerouslySetInnerHTML={{ __html: hljs.highlight(block.code, { language, ignoreIllegals: true }).value }} /> : <code>{block.code}</code>}
        </pre>
      );
    }
    case "table":
      return (
        <table>
          <thead>
            <tr>
              {block.header.map((cell, i) => (
                <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                  <Runs runs={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                    <Runs runs={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "image":
      return <img src={block.src.startsWith("/api/") ? withShare(block.src) : block.src} alt={block.alt} draggable={false} />;
  }
}

type Item = Extract<Block, { type: "bullets" }>["items"][number];

/** Bullets are stored flat with a level; draw them as nested lists. */
function List({ items }: { items: Item[] }): ReactNode {
  const groups: { item: Item; children: Item[] }[] = [];
  const level = items[0]?.level ?? 0;
  for (const item of items) {
    if (item.level <= level || groups.length === 0) groups.push({ item, children: [] });
    else groups[groups.length - 1].children.push(item);
  }
  const Tag = items[0]?.ordered ? "ol" : "ul";
  return (
    <Tag>
      {groups.map((g, i) => (
        <li key={i}>
          <Runs runs={g.item.runs} />
          {g.children.length > 0 && <List items={g.children} />}
        </li>
      ))}
    </Tag>
  );
}

function Runs({ runs }: { runs: Run[] }) {
  return runs.map((run, i) => <RunView key={i} run={run} />);
}

function RunView({ run }: { run: Run }) {
  let node: ReactNode = run.text.includes("\n")
    ? run.text.split("\n").flatMap((part, i) => (i === 0 ? [part] : [<br key={i} />, part]))
    : run.text;
  if (run.code) node = <code>{node}</code>;
  if (run.mark) node = <mark>{node}</mark>;
  if (run.strike) node = <s>{node}</s>;
  if (run.italic) node = <em>{node}</em>;
  if (run.bold) node = <strong>{node}</strong>;
  if (run.link)
    node = (
      <a href={run.link} target="_blank" rel="noopener noreferrer">
        {node}
      </a>
    );
  return node;
}
