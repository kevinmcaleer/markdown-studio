import { calloutKinds } from "../callouts";
import { keyLabel } from "../format/items";
import type { SlashCommand } from "../slashMenu";
import { Popover, type Anchor } from "./Popover";

// The "?" button: a cheat sheet of Markdown, the keyboard shortcuts and the
// "/" commands, for anyone who hasn't written Markdown before. Each topic is
// a fold, one open at a time so the sheet stays short; the first starts open. A host adds its
// own topics (a project page's Bill of Materials, say) with the `guide` option.

/** One topic in the guide: rows of what to type and what it does, and an optional line under them. */
export type GuideSection = {
  title: string;
  rows: [string, string][];
  note?: string;
};

export type GuideShortcut = { label: string; keys: string };

const TEXT: GuideSection = {
  title: "Text",
  rows: [
    ["# Heading", "Heading (## and ### for smaller ones)"],
    ["**bold**", "Bold"],
    ["*italic*", "Italic"],
    ["~~struck~~", "Strikethrough"],
    ["==marked==", "Highlight"],
    ["`code`", "Inline code, in the code font"],
    ["[text](https://…)", "Link"],
    ["- item", "Bulleted list"],
    ["1. item", "Numbered list"],
    ["- [ ] task", "Checklist"],
    ["> quote", "Quote"],
    ["```", "Code block (a line of ``` above and below; ```python names the language)"],
    ["---", "Horizontal line"],
    ["[^1]", "Footnote"],
  ],
};

const PICTURES: GuideSection = {
  title: "Pictures",
  rows: [
    ["![alt](https://…)", "Picture, with alt text for screen readers"],
    ["![alt](…){full}", "The width of the text"],
    ["![alt](…){half}", "Half the size"],
    ["![alt](…){cover}", "A full-width banner, cropped to fit"],
    ["![alt](…){small}", "A quarter of the size"],
    ["| ![a](…) | ![b](…) |", "A table of pictures shows as a grid of cards; text beside a picture is its caption"],
    ["::: gallery filmstrip", "A gallery of the picture lines under it, up to a line of :::, in their order (also bento or lightbox)"],
  ],
  note: "Paste or drop pictures straight onto the text. Hover over a picture to change its size.",
};

const CALLOUTS: GuideSection = {
  title: "Callouts",
  rows: [
    ["> [!note]", "A coloured box; the lines under it start with > too"],
    ["> [!tip] My title", "With your own title"],
    ["> [!warning]-", "Folded: click the title to open it (+ starts open)"],
    ["> | a | b |", "A table inside a callout"],
  ],
  note: `Types: ${calloutKinds.map((kind) => kind.type).join(", ")}.`,
};

const TABLES: GuideSection = {
  title: "Tables",
  rows: [
    ["| a | b |", "Table: a header row, then | --- | --- |, then a row per line"],
    ["| :--- | :---: | ---: |", "Left, centred and right columns (or Align column in the column menu)"],
    ["| ## Title |", "A heading in a cell"],
    ["Shift+Enter", "A new line in a cell, saved as <br>"],
    ["Drag a handle", "Moves its row or column (or use Move in its menu)"],
    ["Split table here", "In a row's menu: starts a new table at that row"],
    ["Delete header row", "In the header's menu: the first row moves up"],
  ],
  note: "Click a table to edit its cells; the handles and menus appear round it.",
};

const CHECKING: GuideSection = {
  title: "Checking your writing",
  rows: [
    ["F7", "Step through each misspelt word, from the cursor on"],
    ["Spelling count", "The book in the status bar: click it to check spelling"],
    ["Hints", "The hints button in the status bar lists passive voice, long sentences, adverbs and wordy phrases, with an example and a one-click fix where there is one"],
  ],
};

export function Guide({
  anchor,
  onClose,
  shortcuts,
  commands,
  spelling = true,
  hints = true,
  sections = [],
}: {
  anchor: Anchor;
  onClose: () => void;
  shortcuts: GuideShortcut[];
  commands: SlashCommand[];
  /** Whether the spelling check is on, so its rows apply. */
  spelling?: boolean;
  /** Whether writing hints are on. */
  hints?: boolean;
  /** The host's own topics, after the built-in ones. */
  sections?: GuideSection[];
}) {
  const checking: GuideSection = {
    ...CHECKING,
    rows: CHECKING.rows.filter(([what]) => (what === "Hints" ? hints : spelling)),
  };
  const topics = [TEXT, PICTURES, CALLOUTS, TABLES, ...(checking.rows.length ? [checking] : []), ...sections];
  return (
    <Popover anchor={anchor} onClose={onClose} className="mde-guide" label="Markdown guide">
      {topics.map((section, i) => (
        <details key={section.title} name="mde-guide" open={i === 0}>
          <summary>{section.title}</summary>
          <table>
            <tbody>
              {section.rows.map(([code, what]) => (
                <tr key={code}>
                  <td>
                    <code>{code}</code>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {section.note && <p className="mde-guide-note">{section.note}</p>}
        </details>
      ))}
      <details name="mde-guide">
        <summary>Shortcuts</summary>
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
      </details>
      {commands.length > 0 && (
        <details name="mde-guide">
          <summary>Type / for</summary>
          <p className="mde-guide-note">{commands.map((c) => c.label).join(" · ")}</p>
        </details>
      )}
    </Popover>
  );
}
