// The apps in the suite. Each gets its own path prefix and, later, its own bundle.

export type SuiteApp = {
  id: "notes" | "tables" | "decks";
  name: string;
  path: string;
  description: string;
  epic: number;
  ready: boolean;
};

export const SUITE_APPS: SuiteApp[] = [
  {
    id: "notes",
    name: "Notes",
    path: "/notes",
    description: "Markdown documents with live preview, sharing and threaded comments.",
    epic: 3,
    ready: true,
  },
  {
    id: "tables",
    name: "Tables",
    path: "/tables",
    description: "A simple database with a spreadsheet-style grid, forms and queries.",
    epic: 9,
    ready: false,
  },
  {
    id: "decks",
    name: "Decks",
    path: "/decks",
    description: "Slides written in Markdown, exported to PowerPoint and Keynote.",
    epic: 11,
    ready: true,
  },
];
