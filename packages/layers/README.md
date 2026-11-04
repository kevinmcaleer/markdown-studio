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
  loadModel: async () => model,      // the project's 3D model ({ version, stamp, parts } or null); with saveModel, scenes share it
  saveModel: async model => { ... }, // store it; called on a scene's Done when its parts or joints changed
  updateScenes: false,               // true: draw every 3D picture again from the model as it opens (Update / Next step)
  stepNumber: 3,                     // this graphic's step from its place in the host's steps; a lone step badge follows it unless typed in
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
  files*, or the *Assembly step* template (a step number, a grey floor and
  the scene; no words, as on a flat-pack sheet). Double-click a scene to open its
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
  branch comes apart together, with dashed **draft lines** from each part
  back to where it fits (Style: *Draft lines when exploded*). **Ghost**
  draws a part faint, for parts fitted in an earlier step.
- **The step frame**, as on a flat-pack sheet, from a 3D scene's bar:
  *Parts strip* boxes the parts the step uses beside the picture, as on a
  LEGO sheet: an outlined box with a small drawing of each kind, left to
  right, its count under it ("2x"), in as many rows as it takes so every
  part sits inside the box (the highlighted parts, or every shown part when
  none is highlighted). An assembly step (one with a step number) gets its
  strip the first time its scene is drawn, under the number, and a strip is
  drawn again whenever its scene is. *Arrows* adds a solid arrow along
  each exploded joint, from the part towards where it fits, sized to the
  drawing, and a turn arrow on a part that turns. An arrow stays on its
  draft line: drag it and it slides along the line, drag an end and the
  end slides too, and it follows the line when the scene is drawn again or
  moved (Alt-drag an end to take it off the line). Under Views, the star
  marks the project's **default view**: new steps start from it, and a step
  that looks from more than 30° off it gets a "turn it" mark at the
  picture's top right (removed when it looks from the default view again).
- **Draft lines break the lines they cross**: where a dashed (or solid)
  draft line passes in front of a part, the outlines and fold lines it
  crosses open either side of it, as on a printed sheet, with the parts'
  fills left whole. Where it passes behind or inside a part it's drawn
  plain, and the outline stays whole.
- **Parts list** (Templates): every kind of part in the project's model
  (or the first 3D scene's parts) drawn at one scale with its name and
  count, and the **fixings** together in a box at the bottom, each with
  its count. A part no more than 12 mm across (its middle dimension,
  whatever its length) counts as a fixing: screws, nuts, pegs, axles.
- **Assembly guide**: `handle.assemblyGuide({ title, each })` draws a whole
  flat-pack booklet from the project's model, a page at a time, handing
  each page to `each` (to upload, say): a cover with the finished
  assembly, a *Before you start* page of tips and tools, the parts list,
  then one step per part. The first step fits the second part onto the
  first; each step's fixings go with the part they're joined to, the
  parts of earlier steps are ghosts, the new ones are highlighted and
  drawn apart along their joints with arrows, a parts box and a pinned
  step number, and no words, as on a flat-pack sheet. Every page looks from the project's default view (or the
  usual one), framed round the whole assembly. It draws on the editor's
  own page, so mount one out of sight for it. Every page is an ordinary
  graphic afterwards, to open and tidy.
- **Detail circles**, as on a flat-pack sheet: from a scene's bar, *Detail
  circle…* picks a part and adds a magnifier: a white disc with a bold ring
  and a **tail** that curves in to the spot it magnifies (the part's middle
  to start). Drag the tail's tip to magnify somewhere else; the circle
  shows that spot at **zoom** times the picture's own scale (2x to start,
  set in the bar), whatever size the circle is stretched to. The zoom is
  written in a white box on the ring ("2x"; *Label* turns it off), and a
  small part under the tip (a screw, not a panel) is drawn whole over the
  ring, so both break its line as on IKEA's sheets; the bar's part list
  picks which part, or none. Where the tail's tip touches, the picture's
  outline opens round it (the spot is cut back to the parts' fills), so
  it's clear what the circle shows. It's drawn again whenever its scene is,
  and moving the circle moves the tail's start with it. A circle whose part
  is hidden or gone is removed with its scene's next drawing.
- **Join snaps**, as in Snakie's Build workspace: while joining, the face
  under the pointer is tinted and its snap points shown: its middle,
  corners and edge middles, the centre of each round hole in it, or, on a
  curved face, the round rims at its ends (a screw's neck, a peg's end, the
  inside of a hole). A click takes the snap nearest the pointer, so a
  screw's neck goes into a screw hole (`src/scene/snaps.ts`).
- The **parts list is a tree**: a joined part sits under the part it's
  joined to, with its joint as a row between them. Click the joint to see
  it (the parent's face tinted blue, the joined part's orange, and the
  points joined); the pencil picks the faces again and the unlink button
  removes the joint, leaving the part where it is.
- **Joint types**: a joint is **Fixed**, **Turns** (revolute, about the
  joined faces' normal) or **Slides** (prismatic, along it). A moving joint
  has From/To limits (degrees or mm), and its Angle or Slide is where it
  sits in this picture, kept inside them.
- **URDF** in the top bar downloads the parts as a robot: `robot.urdf` and
  `meshes/*.stl` in a .zip, in Snakie's conventions (metres, meshes scaled
  0.001, each joined part's link frame at its joint point, joints at their
  zero pose with axis and limits), so it opens in Snakie's Build workspace
  (`src/scene/urdf.ts`).
- **One project model**: with the host's `loadModel`/`saveModel`, a
  project's 3D scenes share one model of parts and joints. A new scene shows
  all of it; each scene keeps only what it shows of each part (the eye,
  ghost and highlight buttons in the parts list), plus its own camera,
  explode and style. Done saves any change to the parts or joints as a new
  version (`stamp`), and a scene opened again follows the model (parts new
  to it start hidden). A scene from before there was a model becomes the
  model, or, when one exists, offers **Use the project model**.
- **Out of date**: a 3D picture drawn from an older version of the model has
  an amber frame and "Out of date" in the editor (never in the saved PNG),
  and **Update picture** on its bar. Nothing is redrawn without asking.
- **Next step** (`nextStepDoc` in doc.ts): a copy of a graphic whose 3D
  scenes show what was shown as ghosts (fitted already) and whose step
  numbers go up by one. The Markdown editor offers it on graphics with a 3D
  scene, and an "Out of date · Update" mark on ones behind the model.
- **Zoom to what you pick**: clicking a part or a joint in the parts list
  turns the camera to it (a joint: its two faces with a little of each part
  round them). Fit shows everything again.
- Snaps are found on faces that export badly too: a border that doesn't
  join up still gives its middle and corners, and a small flat face above
  shallow sides is read as flat, not as part of a round surface.
- **Named views** (Views in the scene's toolbar), like Fusion 360's: save
  the camera under a name, then use, update or delete it. With the host's
  project model they're the project's (saved with it, without making
  pictures out of date), so every picture can use the same view.
- **Step numbers follow the write-up**: with the host's `stepNumber`, a
  graphic with one step badge (the Assembly step and Step heading
  templates, or a badge from Elements) takes the step before it plus one.
  Typing a number pins it (`badgePinned`); **Auto-number** on its bar
  undoes that. The Markdown editor counts the graphics top to bottom and
  marks any whose number is out of place "Out of date · Update".
- Shapes have **W** and **H** fields for exact sizes. Stretching a box keeps
  its corner size.
- Smart guides snap to the page's and other layers' edges and middles
  (hold Alt to move freely). Ctrl+Z/Ctrl+Shift+Z, Ctrl+D, Ctrl+C/V,
  Ctrl+G, arrows to nudge, Delete, T for text, R for a rectangle, Esc,
  Ctrl+S or Ctrl+Enter for Done.

Built on [Fabric.js](https://fabricjs.com) 6, the engine of kevsrobots.com's
instruction builder. `npm run dev -w packages/layers` opens `demo/`.
