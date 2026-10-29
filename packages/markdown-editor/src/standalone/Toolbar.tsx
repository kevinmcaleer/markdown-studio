import type { ReactNode } from "react";
import type { Active, Block } from "../format/formatting";
import { ITEMS, itemTitle, type FormatItem } from "../format/items";
import type { BuiltInTool, Pane, ToolbarButton, ToolbarItem } from "./options";

// The mounted editor's toolbar: the Notes format bar's look, built from the
// host's list of built-in names and its own buttons.

const HEADINGS: { block: Block; label: string }[] = [
  { block: "paragraph", label: "Normal text" },
  { block: "h1", label: "Heading 1" },
  { block: "h2", label: "Heading 2" },
  { block: "h3", label: "Heading 3" },
  { block: "h4", label: "Heading 4" },
];

type ViewTool = { id: string; label: string; keys?: string; icon: string };

/** The buttons that change the view rather than the text. */
export const VIEW_TOOLS: Record<"find" | "outline" | "raw" | "preview" | "side-by-side" | "fullscreen" | "guide", ViewTool> = {
  find: { id: "find", label: "Find and replace", keys: "Mod-F", icon: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.75 10.75 14 14" },
  outline: { id: "outline", label: "Outline", icon: "M2.5 4h11M5 8h8.5M7.5 12h6" },
  raw: { id: "raw", label: "Raw Markdown", icon: "M2.5 12V4l3 4 3-4v8M11.5 4v8M9.5 10l2 2 2-2" },
  preview: { id: "preview", label: "Preview", keys: "Mod-Shift-P", icon: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
  "side-by-side": { id: "side-by-side", label: "Side by side", keys: "F9", icon: "M2.5 3h11v10h-11zM8 3v10" },
  fullscreen: { id: "fullscreen", label: "Full screen", keys: "Mod-Shift-F", icon: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" },
  guide: { id: "guide", label: "Markdown guide", icon: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM6.25 6.25a1.75 1.75 0 1 1 2.4 1.63c-.4.16-.65.54-.65.97v.4M8 11.25h.01" },
};

export type ToolbarState = {
  active: Active;
  readOnly: boolean;
  pane: Pane;
  fullscreen: boolean;
  outline: boolean;
  raw: boolean;
  previewEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

/** An icon from a stroke path, an <svg> string, or a text label. */
export function Icon({ icon, label }: { icon?: string; label: string }) {
  if (!icon) return <span className="mde-tool-text">{label}</span>;
  if (icon.trim().startsWith("<")) return <span className="mde-tool-svg" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />;
  if (/^[Mm][\d\s.,-]/.test(icon.trim()))
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d={icon} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return <span className="mde-tool-text">{icon}</span>;
}

/** Splits the list into groups at each "|". */
function groups(items: ToolbarItem[]): ToolbarItem[][] {
  const out: ToolbarItem[][] = [[]];
  for (const item of items) {
    if (item === "|") out.push([]);
    else out[out.length - 1].push(item);
  }
  return out.filter((g) => g.length);
}

export function Toolbar({
  items,
  state,
  onFormat,
  onHeading,
  onTool,
  onCustom,
  customActive,
  dictation,
}: {
  items: ToolbarItem[];
  state: ToolbarState;
  onFormat: (item: FormatItem, button: HTMLButtonElement) => void;
  onHeading: (block: Block) => void;
  onTool: (id: keyof typeof VIEW_TOOLS, button: HTMLButtonElement) => void;
  onCustom: (tool: ToolbarButton, button: HTMLButtonElement) => void;
  customActive: (tool: ToolbarButton) => boolean | undefined;
  dictation?: ReactNode;
}) {
  const { active, readOnly } = state;
  const heading = HEADINGS.some((h) => h.block === active.block) ? active.block : "paragraph";

  const pressed = (id: string): boolean | undefined => {
    switch (id) {
      case "preview":
        return state.pane === "preview";
      case "side-by-side":
        return state.pane === "split";
      case "fullscreen":
        return state.fullscreen;
      case "outline":
        return state.outline;
      case "raw":
        return state.raw;
      default:
        return undefined;
    }
  };

  const render = (item: Exclude<ToolbarItem, "|">) => {
    if (typeof item !== "string") {
      return (
        <button
          key={`custom-${item.id}`}
          type="button"
          className={`format-btn mde-tool-${item.id}`}
          title={item.label}
          aria-label={item.label}
          aria-pressed={customActive(item)}
          onClick={(e) => onCustom(item, e.currentTarget)}
        >
          <Icon icon={item.icon} label={item.label} />
        </button>
      );
    }
    const name = item as Exclude<BuiltInTool, "|">;
    if (name === "heading")
      return (
        <select
          key="heading"
          className="format-heading"
          aria-label="Text style"
          title="Text style"
          value={heading}
          disabled={readOnly}
          onChange={(e) => onHeading(e.target.value as Block)}
        >
          {HEADINGS.map((h) => (
            <option key={h.block} value={h.block}>
              {h.label}
            </option>
          ))}
        </select>
      );
    if (name === "dictate") return dictation ? <span key="dictate">{dictation}</span> : null;
    if (name in VIEW_TOOLS) {
      const tool = VIEW_TOOLS[name as keyof typeof VIEW_TOOLS];
      if ((name === "preview" || name === "side-by-side") && !state.previewEnabled) return null;
      return (
        <button
          key={name}
          type="button"
          className={`format-btn mde-tool-${name}`}
          title={itemTitle(tool)}
          aria-label={tool.label}
          aria-pressed={pressed(name)}
          // Find, Preview and the rest still make sense on a read-only document.
          onClick={(e) => onTool(name as keyof typeof VIEW_TOOLS, e.currentTarget)}
        >
          <Icon icon={tool.icon} label={tool.label} />
        </button>
      );
    }
    const format = (ITEMS as Record<string, FormatItem>)[name];
    if (!format) return null;
    const disabled = readOnly || (name === "undo" && !state.canUndo) || (name === "redo" && !state.canRedo);
    return (
      <button
        key={name}
        type="button"
        className={`format-btn mde-tool-${name}`}
        title={itemTitle(format)}
        aria-label={format.label}
        aria-pressed={format.on ? format.on(active) : undefined}
        disabled={disabled}
        onClick={(e) => onFormat(format, e.currentTarget)}
      >
        <Icon icon={format.icon} label={format.label} />
      </button>
    );
  };

  return (
    <div
      className="format-bar mde-toolbar"
      role="toolbar"
      aria-label="Formatting"
      // Keep the editor's selection while clicking buttons.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLSelectElement)) e.preventDefault();
      }}
    >
      {groups(items).map((group, i) => (
        <div className={i === 0 ? "format-group first" : "format-group"} key={i}>
          {group.map((item) => render(item as Exclude<ToolbarItem, "|">))}
        </div>
      ))}
    </div>
  );
}
