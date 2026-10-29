import { keyLabel } from "../format/items";
import type { SlashCommand } from "../slashMenu";
import { Popover, type Anchor } from "./Popover";

// The "?" button: a cheat sheet of Markdown, the keyboard shortcuts and the
// "/" commands, for anyone who hasn't written Markdown before.

const SYNTAX: [string, string][] = [
  ["# Heading", "Heading (## and ### for smaller ones)"],
  ["**bold**", "Bold"],
  ["*italic*", "Italic"],
  ["~~struck~~", "Strikethrough"],
  ["==marked==", "Highlight"],
  ["`code`", "Inline code"],
  ["[text](https://…)", "Link"],
  ["![alt](https://…)", "Image"],
  ["![alt](https://…){small}", "Image size: {half}, {cover} or {small}"],
  ["- item", "Bulleted list"],
  ["1. item", "Numbered list"],
  ["- [ ] task", "Checklist"],
  ["> quote", "Quote"],
  ["```", "Code block (a line of ``` above and below)"],
  ["---", "Horizontal line"],
  ["| a | b |", "Table"],
  ["[^1]", "Footnote"],
];

export type GuideShortcut = { label: string; keys: string };

export function Guide({
  anchor,
  onClose,
  shortcuts,
  commands,
}: {
  anchor: Anchor;
  onClose: () => void;
  shortcuts: GuideShortcut[];
  commands: SlashCommand[];
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} className="mde-guide" label="Markdown guide">
      <h3>Markdown</h3>
      <table>
        <tbody>
          {SYNTAX.map(([code, what]) => (
            <tr key={code}>
              <td>
                <code>{code}</code>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Shortcuts</h3>
      <table>
        <tbody>
          {shortcuts.map((s) => (
            <tr key={s.label}>
              <td>
                <kbd>{keyLabel(s.keys)}</kbd>
              </td>
              <td>{s.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Type / for</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {commands.map((c) => c.label).join(" · ")}
      </p>
    </Popover>
  );
}
