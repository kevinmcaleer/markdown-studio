# Layers

A Canva-style editor for graphics made of text, shapes and pictures, for
documentation: labelled photos, step diagrams, title cards.

A graphic is saved as an ordinary **PNG with its layers stored inside it**
(a compressed `iTXt` chunk with the keyword `layers`). The picture shows
anywhere a picture does, and opening it in Layers again brings back every
layer. Pictures placed in a graphic are carried inside it too, so it never
depends on another file.

```js
import { mount, readDoc } from "@markdown-studio/layers";

const editor = mount(el, {
  doc: await readDoc(url),           // or null for a new graphic
  picture: null,                     // or a picture to start from (fills the page)
  mode: "inline",                    // or "full"; the Full screen button switches
  fetchImage: url => fetch(url, { credentials: "include" }).then(r => r.blob()),
  listImages: async () => [{ url, title }],   // offered under Uploads
  listModels: async () => [{ url, title, thumbnail }],   // STL files offered in a 3D scene; thumbnail (optional) is an image URL or () => Promise<Blob|URL>, else the model is drawn
  fetchModel: url => fetch(url, { credentials: "include" }).then(r => r.arrayBuffer()),
  onDone: async ({ png, doc, title }) => { /* upload png, put it in the page */ },
  onCancel: () => editor.destroy(),
});
```

`@markdown-studio/layers/doc` has the PNG and document helpers on their own
(`readDoc`, `extractDoc`, `embedDoc`), without Fabric.js.

- **Side rail**: Templates, Elements (shapes, lines, arrows, step numbers),
  Text (styles), Uploads (upload, drop, paste, the host's pictures), Layers
  (reorder by dragging, rename, hide, lock) and Page (size, "Fit to contents" with a margin, colour or
  see-through).
- **Selection bar**: changes with what's selected (font, size, colours,
  border, dashes, corners (slider plus a number box), step number, flip, fill page), plus
  transparency, position (layer order, line up on the page) and group.
- **Connectors** for hand-made process maps: shapes have snap points in
  the middle of each side. Hover a shape for + handles: drag one to draw an
  arrow, or click it for a joined-on copy of the shape. Drag a line's end
  onto a snap point (or onto a shape, for the side facing the other end)
  and it stays fastened when the shape moves; Shift keeps the angle to 45°
  steps, Alt places it freely. Lines have arrow-at-start/end toggles.
- **Text in shapes**: double-click a shape (or select it and press Enter) to
  type in it. The shape's bar has the font, size, colour, bold/italic/
  underline and alignment for its text, which moves and turns with it.
- **Align and distribute**: with several things selected, the bar lines
  them up by their left edges, centres, right edges, tops, middles or
  bottoms, and spaces three or more evenly across or up and down. Lines
  fastened to the shapes follow them.
- **3D scenes** for assembly instructions: Elements → *3D scene from STL
  files*, or the *Assembly step* template. Double-click a scene to open its
  3D workspace: add STL files (the host's `listModels`, an upload, or a
  drop), move and turn each part with handles or exact X/Y/Z (mm) and
  Roll/Pitch/Yaw (°) boxes (arrow keys step, Shift ×10, Alt ×0.1, or drag a
  label), highlight parts, look from Iso/Front/Side/Top, and pick a style.
  Parts are drawn as line art: a flat fill, fine lines where the surface
  folds, and a bold outline round each part (see `src/scene/render.ts`).
  The scene is see-through, so the page colour is its background. Its
  picture is drawn at twice the page size, and stretching the layer draws
  it again in the new shape. Models from the host are stored by URL;
  uploads are carried inside the graphic (up to 6 MB). three.js loads only
  when a scene is opened.
- **Joints and exploded views** in 3D scenes: *Join to another part…* picks
  a face on the part and then the face on another part it fits against;
  it turns to meet it flush and moves with it from then on (the maths of
  Snakie's Build-workspace joints, `src/scene/joint.ts`). Spin and Gap
  adjust it about and along the joint. The **Explode** slider slides every
  joined part out along its joint by its own Explode distance, so a joined
  branch comes apart together. **Ghost** draws a part faint, for parts
  fitted in an earlier step.
- Shapes have **W** and **H** fields for exact sizes. Stretching a box keeps
  its corner size.
- Smart guides snap to the page's and other layers' edges and middles
  (hold Alt to move freely). Ctrl+Z/Ctrl+Shift+Z, Ctrl+D, Ctrl+C/V,
  Ctrl+G, arrows to nudge, Delete, T for text, R for a rectangle, Esc,
  Ctrl+S or Ctrl+Enter for Done.

Built on [Fabric.js](https://fabricjs.com) 6, the engine of kevsrobots.com's
instruction builder. `npm run dev -w packages/layers` opens `demo/`.
