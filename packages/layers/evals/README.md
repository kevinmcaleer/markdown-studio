# 3D scene evals

An **eval** is a fixed set of example problems, each with the answer a
person would accept, run again after every change to see whether the
scene editor got better or worse. Unit tests (`src/**/*.test.ts`) say
"this function still does what it did". Evals say "the editor still makes
the choices a person would", and give a **score** instead of a plain pass
or fail, so a change that makes things a bit worse still shows.

They cover the parts of 3D scenes that rely on guesses:

| Folder | What is checked |
| --- | --- |
| `cases/snaps/` | Clicking a face offers the snap points a person expects (middle, corners, edge middles, holes, rims), and no others |
| `cases/screw/` | Auto screw picks the size and length you'd buy for a hole (or the right heat-set insert) |
| `cases/joint/` | Joining two picked snaps puts the part flush where it belongs, turned the right way |
| `cases/placement/` | A new part lands beside the others: not inside one, not far away, and in its CAD spot when that fits |
| `cases/fit/` | Fit fills the picture with the parts and cuts none off |
| `cases/arrow/` | An assembly arrow's head is always in sight, and the arrow is no shorter than it needs to be |
| `cases/track/` | Make track's pieces join up all the way round, and none cuts into a wheel |
| `cases/wire/` | A wire leaves each plug straight out, lies on the faces it's routed over (not in them), takes up its slack, sags or bows the right way, and its ends stay on their parts when exploded |
| `cases/pictures/` | Whole scenes drawn with the real renderer, compared with approved pictures |

## Running them

```bash
npm run eval -w packages/layers           # score every case
npm run eval:pictures -w packages/layers  # draw the picture cases and compare them
```

Both print a scorecard and write it to `evals/out/` (`report.md`,
`pictures.md`, and each picture drawn with a `.diff.png` that marks
differences in red). CI runs both on every pull request. The scorecard is
on the run's summary page, and `evals/out/` can be downloaded as the
`scene-evals` artifact.

## What a case is

One JSON file: a small scene, and the answer you'd accept.

```json
{
  "title": "M3 hole through a 3 mm plate",
  "why": "A 3.2 mm hole takes M3. Through 3 mm with 1.5 × 3 mm to spare is 7.5 mm, so the next length sold is 8.",
  "input": {
    "shape": { "plate": [40, 20, 3], "holes": [{ "at": [0, 0], "r": 1.6 }] },
    "click": { "at": [0, -2.1, 3] }
  },
  "expect": { "d": 3, "length": 8, "through": true }
}
```

- **input** is what the editor is given. Here that's a part and where you
  click on it.
- **expect** is the right answer, worked out **by a person**, never copied
  from what the code does today. Copy today's output and the eval can only
  spot changes, not mistakes.
- **why** says how the answer was worked out, so whoever reads a failure
  later can tell whether the case or the code is wrong.

Parts are written as simple shapes (see `lib/shapes.ts`). Each one sits on
the floor (z = 0), centred on x and y:

- `{ "box": [w, d, h] }`
- `{ "plate": [w, d, t], "holes": [{ "at": [x, y], "r": 1.6 }, { "at": [x, y], "r": 2, "depth": 5 }] }`. Leave out `depth` for a hole right through.
- `{ "cylinder": [r, h] }`, with its axis up
- `{ "stl": "meshes/leg.stl" }`, a real part. Put the file in `evals/meshes/`.

In `joint`, `fit` and `arrow` cases, parts are centred on their own middle,
as a scene keeps them, so the plate `[40, 40, 4]` has its top face at z = 2.

A `click` is `{ "at": [x, y, z] }` looking straight down. Add
`"looking": [-1, 0, 0]` to look another way. Aim at the face itself. For
a hole, click on the face just beside it.

## How a case is scored

Each case runs a few **checks** (`lib/graders.ts` has one grader per
folder). Each check scores from 0 to 1:

- A yes/no check gets 1 or 0, like "the head is in sight".
- A number check gets **part marks**: full marks within its tolerance,
  falling to none at three times it. A joint 0.1 mm out with a 0.05 mm
  tolerance scores 0.5.

The case's score is the average of its checks (some count double). The
scorecard lists every check that lost marks, with what it got and what it
wanted.

## The baseline: what "worse" means

`baseline.json` holds each case's last accepted score. A run **fails** if
any case scores below its baseline. A case may sit below 100%: that's a
**known miss**, a real weakness the eval found that hasn't been fixed yet.
The baseline holds it where it is, so it can get better but not worse. On
5 November 2026 there were three:

- `snaps/plate-one-hole` and `snaps/plate-big-hole`: a flat face's "centre"
  snap is the middle of its *area*, so a hole pulls it to the other side.
  It's 0.08 mm out for a small hole and 1.6 mm out for a big one. A person
  means the middle of the outline.
- `arrow/tail-behind-post`: when both the start and the tip of an arrow are
  hidden (by two different parts), the arrow isn't shortened, and its head
  is left out of sight.

When a change makes a case better, the scorecard says so. Run
`npm run eval:update -w packages/layers` to keep the new scores as the
baseline, and commit `baseline.json` with the change.

## Pictures

Each file in `cases/pictures/` is a scene (parts, camera, style, explode,
arrows). `pictures.mjs` draws it in a headless browser with the real
renderer and compares it, pixel by pixel, with `pictures/approved/<name>.png`.
The score is the share of line and tint pixels that match; a case passes at
99% unless it sets its own `"pass"`. When a picture fails, open
`evals/out/pictures/<name>.diff.png`: the red shows what moved.

If the change is meant to happen (a new line style, say), look at the new
pictures, then approve them:

```bash
npm run eval:pictures -w packages/layers -- --approve
```

## Adding a case

1. Copy a case in the folder that fits and give it a name that says what it
   is (`m3-insert-shallow.json`).
2. Change `input` to the scene you have in mind.
3. Work out `expect` by hand, as you'd want the editor to do it, and write
   how you did that in `why`.
4. Run `npm run eval -w packages/layers`. A new case has no baseline yet,
   so it must score 100%, or its own `"pass"` mark if you set one.
   - If it scores 100%, run `npm run eval:update` to add it to the
     baseline.
   - If it doesn't, either the editor gets it wrong (you've found a bug:
     keep the case, set `"pass"` to what it scores now, and fix it later)
     or your expected answer was wrong (fix the case).
5. For a picture case, add the JSON to `cases/pictures/`, run with
   `--approve`, and **look at the picture** before you commit it. An approved
   picture is only as good as your check of it.

Real parts make the best cases. To add one from a project, put its STL in
`evals/meshes/` and use `{ "stl": "meshes/<file>.stl" }` as the shape.
