import { slashCommands, type SlashCommand } from "@markdown-studio/markdown-editor";
import { LAYOUTS, type Layout } from "./deck";

// The "/" menu in Decks: the Notes commands that make sense on a slide, plus
// the deck format's own pieces (see deck.ts): `---` for a new slide, `???`
// for presenter notes, and settings comments for layout, transition and hiding.

const LAYOUT_ICON = "M2.5 3h11v10h-11zM2.5 6h11M6.5 6v7";

const layoutLabel: Record<Layout, string> = {
  title: "Title",
  section: "Section header",
  content: "Content",
  quote: "Quote",
  statement: "Statement",
  blank: "Blank",
};

/** A settings line on the slide the cursor is in. */
function setting(text: string, placeholder = ""): SlashCommand["insert"] {
  return () => ({ before: `<!-- ${text}`, placeholder, after: " -->\n" });
}

const slide: SlashCommand[] = [
  {
    id: "slide",
    label: "New slide",
    keywords: ["page", "separator", "---", "next"],
    group: "slide",
    icon: "M2.5 4h11v8h-11zM8 6.5v3M6.5 8h3",
    block: true,
    blankBefore: true,
    insert: () => ({ before: "---\n\n# ", placeholder: "Slide title", after: "\n" }),
  },
  {
    id: "notes",
    label: "Speaker notes",
    keywords: ["presenter", "notes", "???", "script"],
    group: "slide",
    icon: "M3 2.5h7l3 3v8H3zM5.5 7h5M5.5 9.5h5M5.5 12h3",
    block: true,
    insert: () => ({ before: "???\n" }),
  },
];

const settings: SlashCommand[] = [
  ...LAYOUTS.map(
    (layout): SlashCommand => ({
      id: `layout-${layout}`,
      label: `Layout: ${layoutLabel[layout]}`,
      keywords: [layout, "layout", "template"],
      group: "settings",
      icon: LAYOUT_ICON,
      block: true,
      insert: setting(`layout: ${layout}`),
    }),
  ),
  {
    id: "transition",
    label: "Transition",
    keywords: ["animation", "dissolve", "effect"],
    group: "settings",
    icon: "M2.5 4.5h6v7h-6zM10.5 4.5l3 3.5-3 3.5",
    block: true,
    insert: setting("transition: ", "dissolve 1s"),
  },
  {
    id: "hide",
    label: "Hide slide",
    keywords: ["skip", "skipped", "hidden"],
    group: "settings",
    icon: "M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM3 13l10-10",
    block: true,
    insert: setting("skipped"),
  },
];

// A `---` would split the slide, and slide titles only go to level 2.
const notOnSlides = new Set(["divider", "h3"]);

export const deckCommands: SlashCommand[] = [...slide, ...slashCommands.filter((c) => !notOnSlides.has(c.id)), ...settings];
