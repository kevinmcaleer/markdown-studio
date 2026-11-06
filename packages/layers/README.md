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
  back to where it fits (Style: *Draft lines when exploded*). Untick a
  joint's box in the parts list and it stays assembled in this scene;
  pick joints (⌘ or Shift-click their explode buttons) and *Explode only
  these* keeps every other joint assembled. **Ghost**
  draws a part faint, for parts fitted in an earlier step.
- **The step frame**, as on a flat-pack sheet, from a 3D scene's bar:
  *Parts strip* boxes the parts the step uses beside the picture, as on a
  LEGO sheet: an outlined box with a small drawing of each kind, left to
  right, its count under it ("2x"), in as many rows as it takes so every
  part sits inside the box (the highlighted parts, or every shown part when
  none is highlighted). An assembly step (one with a step number) gets its
  strip the first time its scene is drawn, under the number, and a strip is
  drawn again whenever its scene is. *Arrows* turns the scene's **assembly
  arrows** on: a solid arrow drawn in the picture itself along each
  exploded part's gap, from the part to where it fits, flat on to the
  camera and sized to the picture. Being part of the picture, a part in
  front hides an arrow, and a screw's arrow stops at its hole. In the 3D
  workspace (Style: *Arrows when exploded*, and under a joined part's
  joint) each part's arrow can be left out or shortened: *From* and *To*
  are how far along the gap it starts and ends (10% to 92% to start).
  Guide steps have arrows on. Under Views, the star
  marks the project's **default view**: new steps start from it, and a step
  that looks from more than 30° off it gets a "turn it" mark at the
  picture's top right (removed when it looks from the default view again).
- **Draft lines break the lines they cross**: where a dashed (or solid)
  draft line passes in front of a part, the outlines and fold lines it
  crosses open either side of it, as on a printed sheet, with the parts'
  fills left whole. Where it passes behind or inside a part it isn't
  drawn at all: a part in front hides it, as it hides an arrow.
- **Parts list** (Templates): every kind of part in the project's model
  (or the first 3D scene's parts), each filling a slot of its own (not to
  scale) with its count and name under it, and the **fixings** together in
  a box at the bottom, each with its count and name. A part no more than
  12 mm across (its middle dimension, whatever its length) and 8 mm thick
  (its smallest) counts as a fixing: screws, nuts, pegs, axles, but not a
  small motor.
- **Assembly guide**: `handle.assemblyGuide({ title, each })` draws a whole
  flat-pack booklet from the project's model, a page at a time, handing
  each page to `each` (to upload, say): a cover with the finished
  assembly, a *Before you start* page of tips and the tools picked in Steps mode
  (*Tools for the guide*: screwdriver, Allen key and pliers to start),
  the parts list,
  then one step per part. The first step fits the second part onto the
  first; each step's fixings go with the part they're joined to, the
  parts of earlier steps are ghosts, the new ones are highlighted and
  drawn apart along their joints with arrows, a parts box and a pinned
  step number, and no words, as on a flat-pack sheet. Every page looks from the project's default view (or the
  usual one), each step framed round itself so it fills its page. It draws on the editor's
  own page, so mount one out of sight for it. Every page is an ordinary
  graphic afterwards, to open and tidy. With **build steps** (below) it
  draws one page per step instead, titled and viewed as the step says.
- **Build steps** (the 3D scene's **Model / Steps** switch, top of the
  parts panel): build the whole model in Model mode, joints and all, then
  in Steps mode say which parts go on in each step. A strip of step cards
  sits under the view, each with its picture; the picked step shows as its
  guide page will (earlier steps ghosted, its parts highlighted and drawn
  apart with arrows, later parts hidden). Click a part in the list or the
  view to put it in the step shown (or take it out), drag parts or cards
  to move them, and use **Suggest steps** (from the joint tree), **Record
  steps** (click the parts in the order they go on, Next step between
  steps; a part waits until what it's joined to is on, and its screws come
  with it) and **Play steps**. The Step panel has a title, a view, and
  checks: a part joined to one fitted later, or one that runs into an
  earlier part on its way off. Fixings needn't be picked: they go with
  their part. Steps are saved in the project model (`model.steps`,
  `[{ id, title?, parts, view? }]`) without making pictures out of date,
  and the scene's own picture is left as it was unless *Use this step for
  this picture* is pressed. Hover between two step cards for a **+** that
  puts a new step there. The Step panel's *Tools for the guide* picks what
  the guide's Before you start page lists from a catalogue of about 40
  tools in groups (`src/tools.ts`: screwdrivers and keys, cutting, holding,
  electronics, measuring, glue and tape, machines, safety), each with its
  own symbol and, where it has them, its sizes. It is saved as
  `model.guide.tools`: an id (`calipers`), an id and size
  (`allen-key:2.5 mm`), or any other tool's name, drawn as words. The same
  symbols are tiles under Elements. The
  Markdown editor draws its `## Assembly guide` again by itself after a
  graphic saves a model whose steps, tools, views or parts moved on from
  the one it was drawn from (a hidden `<!-- assembly guide: key -->` says
  which).
- **Detail circles**, as on a flat-pack sheet: from a scene's bar, *Detail
  circle…* picks a part and adds a magnifier: a white disc with a bold ring
  and a **tail** that curves in to the spot it magnifies (the part's middle
  to start). Drag the tail (anywhere along it, or by its tip) to magnify
  somewhere else: the circle is drawn again as you drag, and a faint
  **target circle** at the tip shows how much it takes in. Drag the
  target's handle to take in more or less (the zoom follows), press the −
  and + under the ring, or set the **zoom** in the bar: the circle shows
  the spot at that many times the picture's own scale (2x to start),
  whatever size the circle is stretched to. The bar's **look** joins the
  circle to its spot with the flared tail, a thin straight line (as in a
  brick set), or nothing. The bar's **Repeat** is written in a white box
  on the ring: how many times the step is done ("x1" to start; empty it
  for no box), and a
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
- **Wires** (W, or Wire on the view's bar): click a part where the first
  plug goes (a socket already there shows as a green square), click the
  faces the wire runs over, then click a socket or Shift-click a face to
  end it (Enter ends it at the last point, Esc drops it). Each end gets a
  plug: a real connector housing (Molex Mini-SPOX 5264 for STS3215 servo
  leads, JST XH, PH and SH, Dupont), joined to the socket so it comes out of
  it when exploded (`src/scene/connectors.ts`). Every end and waypoint
  belongs to a part, so the wire follows joints and explode. It leaves each
  plug straight out, lies a radius off the faces it's routed over, and its
  slack bows each free span out (or down, when the ends face each other)
  (`src/scene/wire.ts`). Picked, a wire shows its waypoints: drag one over
  the parts, click it to take it out, Shift-click a part to add one. Wires
  are filled in their colour with the normal outline; **Wiring view**
  ghosts every other part, and **Hide wiring** leaves them out of a picture.
- **Cables**: a wire with more than one core (Wires in the wire bar, or
  + in a wire's settings) is a cable along one route: its wires leave each
  plug side by side at the pins' spacing, then lie flat side by side (a
  servo lead) or round in a bundle, twisting round each other, each in its
  own colour (`coreLines` in `src/scene/wire.ts`). **Mirror to the other
  side** makes a picked wire again across the model's YZ plane (left leg to
  right leg), each end in the partner part's mirrored socket
  (`src/scene/wireMirror.ts`).
- **The 2D wiring diagram**: with the host's `wiring` hook (`load`, and
  optionally `addConnections`, `open`, `saveSockets`; see
  `src/scene/wiring2d.ts`), a part links to a part of the diagram and its
  sockets to its ports (an STS3215's "Bus port 1"). A wire between two such
  sockets becomes the diagram's cable there (its wires, pin order and
  colours), or can be added to it; **Add missing wires** routes each of the
  diagram's cables that has sockets at both ends; **Open in wiring
  diagram** goes to it; and a part's sockets can be saved to its catalog
  part, so every project using it gets them (matched by the model's size).
  The diagram's parts not in the scene yet are listed in its Wiring diagram
  settings and under **From the wiring diagram** in Add a part: one whose
  catalog part has a 3D model (`WiringPart.model`, STL or STEP) is added
  from it, linked to the diagram with the catalog's sockets. Models the host
  marks `group: "parts"` (its parts list's catalog parts, with their `slug`)
  are offered under **From the parts list**; each added one links to the
  next of the diagram's parts of that slug.
- **Pins on the model**: a linked part's Wiring diagram settings list its
  ports and pins from the diagram's pinout, and say where each is on the
  model, picked with the joint picker's snaps (hole and rim centres,
  middles, corners). A port a plug goes in (JST, Molex, Dupont) is placed
  as the plug's socket, its pins following the connector's pitch; or each
  pin on its own as a bare pin (`PartSocket.connector` `"pin"`, with
  `pin`): a motor's tabs, a battery snap, a screw terminal, where the wire
  ends with no plug. **Add missing wires** lays a cable between two plugs,
  and a wire per connection where an end is bare pins, each ending on its
  pin (or its pin's place along the plug at the other end). The wire tool's
  Plug **None** ends a wire on a bare pin too. Pins are saved to the
  catalog part with its sockets.
- **Showing the wiring**: wires go in in the model's order (Goes in i of n
  in a wire's settings). **Assemble n wires** plays them in one by one, each
  growing along its route from its first plug (1×/2×/4×, Skip, Esc stops).
  A scene's **Wiring step** draws one wire and its plugs, earlier wires
  grey and later ones out, and Next step moves on to the next wire
  (`lookOf` in `src/scene/model.ts`). **Runs with** ties a wire to another
  for a stretch of it (from/to, as % along that wire), as wires in a loom.
  A wire that bends tighter than 3× its diameter is flagged in its settings,
  and `wireList` on the handle (and `/Wire list` in the Markdown editor)
  gives every wire's ends, colours, length and cut length (+5 mm each end)
  as a Markdown table (`src/scene/wireList.ts`).
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
