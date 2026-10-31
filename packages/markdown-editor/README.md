# @markdown-studio/markdown-editor

Markdown Studio's Notes editor, as a drop-in for any web page: one `<link>`, one
`<script>`, and `MarkdownEditor.mount(element)`. React is bundled inside, so the host
page doesn't need it (or any bundler).

What you get with no configuration:

- **Live preview**: Markdown shows as it reads while you type, with its syntax only on the line you're on. A Raw view shows all of it, with line numbers, and line numbers can be turned on in the live view too.
- **`/` menu** for headings, lists, tables, code, images, links, dates, and the host's own commands.
- **Toolbar** (undo/redo, text style, marks, lists, inserts, preview, side by side, full screen, Markdown guide: a "?" cheat sheet of text, pictures and sizes, callouts, tables, checking your writing, shortcuts and `/` commands, with room for the host's own topics) and a **selection toolbar** over selected text, with Clear formatting.
- **Tables** you edit as a grid, **smart paste** (rich text, spreadsheet cells, code from an IDE and URLs arrive as Markdown) and **image upload** by paste, drop or picker.
- **Proofing**: Hunspell spelling (offline, en-GB and en-US), basic grammar, and a right-click menu with suggestions, a Word-style spelling check (F7) that steps through each misspelt word with Change, Change all, Ignore, Ignore all and Add to dictionary, and a book in the status bar that shows a tick when the whole document is spelt right (or how many words aren't); Look Up, Synonyms, LanguageTool grammar and translation when pointed at a Markdown Studio server (or anything serving the same `/api/language` endpoints).
- **Writing hints** (passive voice, long sentences, adverbs, wordy phrases, readability), with an example for each and one-click rewording where there is one, **outline**, **find and replace**, counts, cursor position.
- **Preview and side by side** with synced scrolling, rendered by the built-in renderer or the host's own.
- **Drafts**: with a `draft.key`, unsaved text survives a crash or reload and is offered back.
- **Full screen** (`Ctrl/⌘+Shift+F`, Escape leaves), **link popover** on `Ctrl/⌘+K`, a **link card** (copy, edit, remove, or name a bare URL) when the caret is on a link, in text or a table cell, heading cycle on `Ctrl/⌘+Alt+=` and `Ctrl/⌘+Alt+-`, and a **"?" cheat sheet** of Markdown, shortcuts and `/` commands.

## Quick start

```html
<link rel="stylesheet" href="/vendor/markdown-editor/markdown-editor.css" />
<script src="/vendor/markdown-editor/markdown-editor.js"></script>

<div id="editor"></div>
<script>
  const editor = MarkdownEditor.mount("#editor", {
    doc: "# Hello\n\nStart writing…",
    onChange: (markdown) => console.log(markdown.length),
    uploadImage: async (file) => {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      if (!res.ok) throw new Error("Upload failed");
      return (await res.json()).url; // the image's URL
    },
    draft: { key: "post-42" },
  });
</script>
```

Or mount it on a form's `<textarea>`: the textarea is hidden and kept in sync, so the form
posts the Markdown as before, and a submit clears the draft.

```html
<form method="post">
  <textarea name="body"># Draft</textarea>
  <button>Save</button>
</form>
<script>
  MarkdownEditor.mount(document.querySelector("textarea[name=body]"), { draft: { key: "blog-new" } });
</script>
```

`demo/index.html` is a working page with both (build first, then serve the package folder:
`npm run build -w packages/markdown-editor && python3 -m http.server -d packages/markdown-editor`,
and open `/demo/`).

### Hosting the files

Copy everything in `dist/` that the script needs and serve it together:

| File | What |
| --- | --- |
| `markdown-editor.js` | The editor, as one script that sets `window.MarkdownEditor`. The spell checker's worker is inside it. |
| `markdown-editor.css` | Its styles, all scoped to `.mde`. |
| `dictionaries/en-GB.dic`, `dictionaries/en-US.dic` | The Hunspell word lists, found beside the script (`proofing.dictionaryBase` moves them). They're fetched once, from the worker, when spelling first runs; with them served from your own site (or cached by its service worker) spelling works offline. |

If the script is served from another origin (a CDN), that origin must send
`Access-Control-Allow-Origin` for the `.dic` files, since the worker fetches them.

Bundlers can use the ESM build instead: `import { mount } from "@markdown-studio/markdown-editor"`
and `import "@markdown-studio/markdown-editor/markdown-editor.css"`; the `dictionaries/`
folder needs to sit beside the built chunk, or set `proofing.dictionaryBase`.

## Options

Every option is optional.

| Option | Default | What |
| --- | --- | --- |
| `doc` | `""` (a textarea's value) | The Markdown to start with. |
| `onChange(markdown)` | | Called after every edit. |
| `readOnly` | `false` | Shows the document without letting it be changed. |
| `placeholder` | `"Start writing…"` | Shown while the document is empty. |
| `autofocus` | `false` | Puts the cursor in the editor on mount. |
| `minHeight`, `maxHeight` | `12rem`, none | CSS lengths (numbers are pixels). With a maximum, the text scrolls inside the editor. |
| `theme` | `"auto"` | `"light"`, `"dark"`, or `"auto"` to follow the system. |
| `direction` | `"auto"` | `"ltr"`, `"rtl"`, or `"auto"` (each line by its own script). |
| `spellcheck` | `"built-in"` | `"built-in"` (Hunspell, grammar, Look Up), `"native"` (the browser's spell checker, our grammar), or `"off"`. |
| `toolbar` | `DEFAULT_TOOLBAR` | Buttons in order; `"|"` is a separator; `false` hides the toolbar. See [Toolbar](#toolbar). |
| `selectionToolbar` | `true` | The floating toolbar over selected text. |
| `status` | `DEFAULT_STATUS` | Status bar items in order, or `false`. See [Status bar](#status-bar). |
| `slashCommands` | | Commands added to the `/` menu, or `(defaults) => commands` to replace the list. See [`/` commands](#-commands). |
| `guide` | | The host's own topics in the `?` Markdown guide, after the built-in ones: `[{ title, rows: [["what to type", "what it does"], …], note? }]`. |
| `insertTexts` | | EasyMDE-style templates: `{ link, image, table, horizontalRule, code }`, each `[before, after]` the cursor. |
| `shortcuts` | | Keys by action, e.g. `{ bold: "Mod-b", link: null }`. `null` turns one off. See [Shortcuts](#shortcuts). |
| `uploadImage(file)` | | Stores an image and resolves to its URL. Without it, images can only be linked by URL. |
| `addImages(files)` | | Keeps several images dropped at once without linking them (a gallery) and resolves when done. Without it, they're all linked where they're dropped. One dropped image is always linked between the lines it lands between, shown by a dotted line while dragging. |
| `imageLibrary()` | | Resolves to `{ url, alt?, thumb? }[]`, the images the picker offers. |
| `images.maxBytes` | 25 MB | Bigger images are turned away with a note under the cursor. |
| `images.accept` | `"image/*"` | Which images are taken, as an `<input accept>` list. |
| `images.onError(message, file)` | | Called when an image is turned away or its upload fails. |
| `images.libraryName` | `"the image library"` | What `addImages` keeps them in, for the notes: "Added 3 images to the gallery". |
| `preview.render(markdown, element)` | built-in | The host's renderer: return HTML (or a promise of it), or fill `element` and return nothing. |
| `preview.markdownIt(md)` | | Adds plugins or options to the built-in markdown-it renderer. |
| `preview.afterRender(element)` | | Runs after each render (to run mermaid on it, say). |
| `preview.className` | `"prose"` | Classes on the rendered HTML's element (use your site's article class to match the published look). |
| `preview` | on | `false` hides Preview and Side by side. |
| `codeRenderers` | | Fenced blocks drawn in the live view, by language: `{ mermaid: (source, element) => … }` shows a ```` ```mermaid ```` block as its diagram, and as its source while the cursor is in it. A renderer fills `element` and can return a promise. |
| `codeEditors` | | Editors for fenced blocks, by language, shown in place of the block's lines while the cursor is in it: `{ mermaid: ({ element, source, onChange, onExit, focus }) => handle }`. Call `onChange(code)` after each edit and `onExit("before" \| "after")` to hand the cursor back; return `{ setSource, focus, destroy }`. With `codeRenderers`, a ```` ```mermaid ```` block shows its diagram until clicked and then, say, a split code + diagram editor (Mermaid Factory's `mountEditor`). |
| `codeLanguages` | | Highlighting for fenced code in more languages, by name: `{ mermaid: MermaidTools.mermaidStreamParser }`. Each is a plain stream parser (`{ token(stream, state), startState? }`, what CodeMirror's `StreamLanguage` takes), so it can come from another bundle with its own copy of CodeMirror. Its token names (`"keyword"`, `"string"`, `"comment"`…) take the editor's colours. A function that resolves to the parser, `() => import(…).then(m => m.mermaidStreamParser)`, loads it the first time a fence needs it. Read once, at mount. |
| `tableRenderer` | | Draws a table another way in the live view: `({ rows, heading }) => element \| null`. `rows` is the header row then the body rows (each cell's Markdown) and `heading` the text of the heading the table sits under. The element shows in place of the grid until the table is clicked or the caret moves in, and comes back when the focus leaves; return `null` to keep the grid. A Videos table drawn as thumbnail cards, say. |
| `tableNote` | | A note above a table in the live view: `({ rows, heading }) => element \| null`, given what `tableRenderer` is given. The element shows above the table (in grid and drawing alike) and clicks in it are the host's; return `null` for no note. A tip on a Bill of Materials' Qty and Price columns, say. |
| `pane` | `"edit"` | Opens in `"edit"`, `"preview"` or `"split"`. |
| `lineNumbers` | `false` | Line numbers beside the live view too (the `line-numbers` toolbar button toggles them). |
| `raw.start` | `false` | Opens in the Raw view rather than the live one. |
| `raw.lineNumbers` | `true` | Line numbers in the Raw view. |
| `raw.tabSize` | `2` | |
| `raw.indentWithTabs` | `false` | |
| `draft.key` | off | Keeps a draft of unsaved text in this browser and offers it back after a reload. One key per document. |
| `draft.delayMs` | `1000` | How long typing pauses before the draft is written. |
| `proofing.languageApiBase` | none | A Markdown Studio server (`https://studio.example.com`) for Look Up, LanguageTool grammar and translation. It's called with credentials, so it needs CORS for your origin. |
| `proofing.languageApi` | none | Sends those requests yourself, in place of `languageApiBase`: `(path, { body }) => Promise<json>`. Use it to add an `Authorization` header; `MarkdownEditor.fetchLanguageApi(base)` is the default one. |
| `proofing.dictionaryBase` | `dictionaries/` beside the script | Where `en-GB.dic` and `en-US.dic` are. |
| `proofing.language` | `"en-GB"` | The proofing language until the writer picks one in the status bar. |
| `lint` | `true` | Writing hints in the status bar. |
| `hints` | `[]` | The host's own hints, `{ id, title, detail?, actions?: [{ label, run }] }`, listed at the top of the hints panel and counted on its button even with writing hints off. |
| `outline` | `false` | Opens the outline beside the text (the `outline` toolbar button toggles it). |
| `speech` | `false` | Dictation (toolbar) and read aloud (status bar), where the browser can. |
| `extensions` | | More CodeMirror 6 extensions. |
| `history` | `true` | CodeMirror's undo history; turn it off when an extension brings its own (co-editing does). |

### Toolbar

`DEFAULT_TOOLBAR` is

```js
["undo", "redo", "|", "heading", "|", "bold", "italic", "strike", "highlight", "code", "link", "|",
 "bullet", "numbered", "checklist", "outdent", "indent", "|",
 "quote", "codeBlock", "table", "image", "divider", "|",
 "preview", "side-by-side", "fullscreen", "|", "spelling", "guide"]
```

Also available: `headingBigger`, `headingSmaller`, `clear`, `find`, `outline`, `raw`, `line-numbers`, and
`dictate` (with `speech: true`).

A host's own button is an object:

```js
{
  id: "diagram",                // also its class: .mde-tool-diagram
  label: "Insert a diagram",   // tooltip and accessible name
  icon: "M2.5 2.5h4v4h-4z…",   // a 16×16 stroke path, an "<svg>…</svg>" string, or text
  run(editor, button) { … },   // the mounted editor's API, and the button to anchor a menu to
  active(editor) { return false }, // optional: shows it pressed
}
```

The image button opens the image picker when there's an `uploadImage` or `imageLibrary`
(the library, an upload button and a URL field); otherwise it inserts an image link to fill in.
The picker also asks what size the image shows at (see [Image sizes](#image-sizes)).

### Status bar

`DEFAULT_STATUS` is `["words", "chars", "reading", "cursor", "draft", "language", "lint"]`.
Also available: `lines` and `read-aloud` (with `speech: true`).

### `/` commands

```js
slashCommands: [
  {
    id: "diagram",
    label: "Diagram",
    keywords: ["mermaid", "flowchart"],
    group: "insert",              // the menu draws a line between groups
    icon: "M2.5 2.5h4v4h-4z…",
    block: true,                  // starts on its own line
    // Either insert text (the placeholder is selected)…
    insert: () => ({ before: "```mermaid\n", placeholder: "flowchart LR", after: "\n```\n" }),
    // …or run something with the CodeMirror view, once "/diagram" is gone.
    run: (view) => openMyDiagramPicker(view),
    // Optional: leave it out of the menu while this returns true.
    hidden: (state) => state.doc.toString().includes("```mermaid"),
  },
]
```

In a table's cell the menu offers only the commands without `block: true`. A
command's text goes into the cell, and a `run` command is called with the editor's
cursor at that place in the cell, so a picker that inserts at the cursor works there too.

`MarkdownEditor.slashCommands` is the built-in list.

### Callouts

Obsidian's callouts (and GitHub's alerts, which are the same syntax) render in the
preview and are drawn as boxes in the live view, with their `[!type]` shown only
while the cursor is on that line:

```markdown
> [!warning] Mind the mains
> Unplug it before you open the case.

> [!tip]- Folded to start with
> A `+` instead of `-` makes it foldable but open.
```

The types are `note`, `abstract`, `info`, `todo`, `tip`, `success`, `question`,
`warning`, `failure`, `danger`, `bug`, `example` and `quote`, with Obsidian's
aliases (`caution`, `error`, `faq`…); anything else renders as a note. The `/`
menu inserts the common ones ("/callout" lists them).

The preview's markup is `div.callout.callout-<type>` (or `details`/`summary` when
foldable) holding `.callout-title` (`.callout-icon`, `.callout-title-text`) and
`.callout-content`. Its stylesheet is `src/callouts.css`, which also works on its
own, so a page that renders the same Markdown elsewhere can look the same.

### Image sizes

A `{size}` straight after an image says how big it shows:

```markdown
![Chassis](/img/chassis.jpg){small}
```

| Modifier | Shows |
| --- | --- |
| none | At its own size, no wider than the text |
| `{full}` | The width of the text |
| `{half}` | Half the size (two on one line sit side by side) |
| `{cover}` | A full-width banner 200px tall, cropped to fit |
| `{small}` | A quarter of the size |

The preview renders it as a class on the `img` (`image-half`…) and drops the
modifier. In the live view, hovering an image shows its sizes and picking one
rewrites the modifier. The stylesheet is `src/image-sizes.css`, which also works
on its own, like `callouts.css`.

### Table column alignment

Each column's handle menu has **Align column** buttons: left, center and right.
They write GFM's colons on the delimiter row (`:---`, `:---:`, `---:`), so any
Markdown renderer aligns the column the same way. Picking the column's current
alignment again sets it back to the default.

### Image grids

A table whose cells hold images is a layout, so it shows as a borderless grid of
image cards, one column per table column, each image fitted to its card:

```markdown
| | | |
| --- | --- | --- |
| ![Base](/img/base.jpg) | ![Lid](/img/lid.jpg) The lid | ![Buttons](/img/buttons.jpg) |
```

Text beside an image is its card's caption. An empty header row is hidden, and a
header row of plain text labels the columns. A table with any text-only cell
outside its header stays an ordinary table. The preview marks the table
`image-grid` (and `image-grid-nohead`) and each image cell `image-card`; the
stylesheet is `src/image-grid.css`, which also works on its own.

### Galleries

A `::: gallery` block shows the image lines inside it as one gallery, in the
order they're written, so choosing pictures is adding or deleting lines and
reordering them is moving lines:

```markdown
::: gallery filmstrip
![Front](/img/front.jpg)
![Wiring](/img/wiring.jpg "Before the lid went on")
:::
```

The word after `gallery` is its layout: `filmstrip` (the first picture large, the
rest as thumbnails that swap it), `bento` (tiles, the first one big) or
`lightbox` (even thumbnails that open full size); none means filmstrip. Text that
isn't an image is left out, and an image's title (or else its alt text) is its
caption. In the live view the block shows as its gallery, with layout buttons on
hover, until the cursor goes in. The preview renders `galleryHtml` (classes
`md-gallery`, `md-gallery-<layout>`, `md-gallery-hero`, `md-gallery-item`);
`wireGallery(element, open?)` adds the filmstrip swap and a viewer hook, and
`src/gallery.css` styles it on its own.

### Cards

A `::: cards` block lays out cards side by side, each a picture, a title and
some words. A line of `---` starts the next card; `:::` ends the block.

```markdown
::: cards
![Open Duck Mini](/odm.jpg)
## Open Duck Mini
Created by Antoine Pirrone.

---

![Microduck](/md.jpg)
## Microduck
By Pollen Robotics and Hugging Face.
:::
```

A card's first picture line is its picture and the rest is any Markdown (its
first heading is its title). `::: cards 3` sets how many across; without a
number they fill the width. They stack on a phone. In the live view the block
is built by pointing and clicking: click a card to set its picture (through the
image picker, `cardPicturePicker`), title and words; hover for move and remove
buttons; "Add card" adds one; the bar sets how many across, and "Markdown"
shows the lines underneath until "Show cards". `/cards` inserts one with its
first card open. The preview renders `cardsHtml` (classes `md-cards`,
`md-card`, `md-card-media`, `md-card-body`), and `src/cards.css` styles it on
its own. Card titles stay out of the outline.

### Headings in table cells

A table cell holds only inline Markdown, so a cell that starts with `#`'s is drawn
as a heading of that level instead: a heading over each column of an image grid,
say. The preview renders it as `<th><h2 class="cell-heading">…</h2></th>`, and
`src/image-grid.css` sets it snug in its cell.

```markdown
| ## Open Duck Mini | ## Microduck |
| --- | --- |
| ![Open Duck Mini](/img/odm.jpg) | ![Microduck](/img/microduck.jpg) |
```

### Shortcuts

`Mod` is ⌘ on a Mac and Ctrl elsewhere. The names and defaults:

| Name | Key | Name | Key |
| --- | --- | --- | --- |
| `bold` | `Mod-b` | `headingBigger` | `Mod-Alt-=` |
| `italic` | `Mod-i` | `headingSmaller` | `Mod-Alt--` |
| `strike` | `Mod-Shift-x` | `bullet` | `Mod-Shift-8` |
| `highlight` | `Mod-Shift-h` | `numbered` | `Mod-Shift-7` |
| `code` | `Mod-e` | `checklist` | `Mod-Shift-9` |
| `link` | `Mod-k` | `indent` / `outdent` | `Mod-]` / `Mod-[` |
| `paragraph` | `Mod-Alt-0` | `clear` | `Mod-\` |
| `h1`, `h2`, `h3` | `Mod-Alt-1`…`3` | `fullscreen` | `Mod-Shift-f` |
| `preview` | `Mod-Shift-p` | `sideBySide` | `F9` |

F7 opens the spelling check (the `spelling` button does too).

Undo, redo and find and replace keep CodeMirror's usual keys.

## The editor's API

`mount(elementOrSelector, options)` returns:

| | |
| --- | --- |
| `getDoc()` / `setDoc(markdown)` | Read or replace the whole document (a dropped `README.md`, say); a replace is one undo step. |
| `getSelection()` / `replaceSelection(text)` | The selected text, or put text in its place (or at the cursor). |
| `focus()` | |
| `setReadOnly(on)` | |
| `setPane("edit" \| "preview" \| "split")`, `setFullscreen(on)`, `setLineNumbers(on)` | |
| `openLinkPopover()`, `openImagePicker(anchorElement?)` | The same as the Link and image buttons. |
| `refreshPreview()` | Renders the preview again (after the host's renderer has changed). |
| `checkSpelling()` | Opens the spelling check at the cursor, as F7 and the `spelling` button do. |
| `setHints(hints)` | Replaces the host's hints in the hints panel (see the `hints` option); `[]` clears them. |
| `clearDraft()` | Forget the stored draft: call it once the host has saved. |
| `on(event, listener)` | Returns a function that removes the listener; `off(event, listener)` does too. |
| `destroy()` | Takes the editor out; a textarea comes back with the latest Markdown. |
| `element`, `view` | The `.mde` root, and the CodeMirror `EditorView` for anything else. |

Events: `change` (the Markdown), `stats` (`{ words, chars, readingMinutes, lines }`), `draft`
(`{ status: "clean" | "pending" | "saved" | "unavailable", savedAt }`), `focus`, `blur`,
`pane`, `fullscreen`.

`window.MarkdownEditor` also has `createMarkdownIt(configure?)` and `renderMarkdown(markdown)`
(the built-in renderer, for rendering a document the same way elsewhere),
`DEFAULT_TOOLBAR`, `DEFAULT_STATUS`, `slashCommands`, `configureLanguageApi`,
`setDictionaryBase` and `version`.

## Theming

The editor's colours and fonts are CSS custom properties set on the `.mde` element, so a
host overrides them there:

```css
.mde {
  --accent: #0b7285;          /* buttons, links, the cursor */
  --font-serif: Georgia, serif; /* headings */
  --mde-min-height: 20rem;
}
```

The tokens: `--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--border`, `--accent`,
`--accent-text`, `--danger`, `--success`, `--radius`, `--shadow`, `--font-sans`,
`--font-serif`, `--font-mono`, `--highlight`, `--code-bg`, `--code-text`, `--syntax-*`, and
`--mde-min-height`, `--mde-max-height`, `--mde-split-height`, `--mde-sticky-top`, `--mde-sticky-bottom`. `theme: "dark"` (or `"auto"`
on a dark system) swaps in the dark set; override those with `.mde[data-theme="dark"]`.

The toolbar sticks to the top of the viewport, and the status bar to the bottom, while the
page scrolls through a long document. On a page with its own fixed header, set
`--mde-sticky-top` to the header's height so the toolbar stops below it; `--mde-sticky-bottom`
does the same for a fixed footer.

## Reproducing the kevsrobots.com EasyMDE toolbar

```js
const editor = MarkdownEditor.mount("#project-body", {
  doc: project.markdown,
  draft: { key: `project-${project.id}` },
  uploadImage,                                  // POSTs to the projects API, resolves to the URL
  imageLibrary: () => fetch(`/api/projects/${project.id}/images`).then((r) => r.json()),
  toolbar: [
    "undo", "redo", "|", "heading", "|", "bold", "italic", "code", "link", "|",
    "bullet", "numbered", "checklist", "|", "quote", "codeBlock", "table",
    { id: "insert-image", label: "Insert image", icon: imageIcon, run: (ed, button) => ed.openImagePicker(button) },
    { id: "diagram", label: "Diagram", icon: diagramIcon, run: (ed, button) => showDiagramMenu(ed, button) },
    "|", "preview", "side-by-side", "fullscreen", "|", "guide",
  ],
  preview: {
    render: (markdown) => siteRenderer.render(markdown), // the site's own renderer, shortcodes and all
    afterRender: (el) => mermaid.run({ nodes: el.querySelectorAll(".mermaid") }),
    className: "project-content",
  },
});
// Dropping a README.md onto the page replaces the document.
dropZone.addEventListener("drop", async (e) => editor.setDoc(await e.dataTransfer.files[0].text()));
// After a successful save:
editor.clearDraft();
```

## Co-editing

Co-editing stays out of the main bundle. With a bundler and your own Yjs:

```js
import { mount } from "@markdown-studio/markdown-editor";
import { collab } from "@markdown-studio/markdown-editor/collab";

mount(el, { history: false, extensions: [collab({ text: ydoc.getText("doc"), awareness: provider.awareness })] });
```

Comments and suggestions are tied to Markdown Studio's server, so they stay in the Notes
app rather than this package.

## Inside Markdown Studio

Notes and Decks build their pages from the same parts this package exports (`Editor`,
`useFormatting`, `slashMenu`, `smartPaste`, `proofing`, `WritingBar`…), compiled from source
through the package's `source` export condition, so there is one editor. Language features
reach the server through `configureLanguageApi`, which the app points at its own API.

## Developing

```bash
npm run build -w packages/markdown-editor      # dist/: ESM, the IIFE script, CSS, dictionaries, types
npm test -w packages/markdown-editor
npm run typecheck -w packages/markdown-editor
```

The word lists are Hunspell's en-GB and en-US dictionaries (`dictionary-en-gb`,
`dictionary-en`); their licences are copied beside them in `dist/dictionaries/`.
