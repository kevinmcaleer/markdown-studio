import { describe, expect, it } from "vitest";
import { ANIMATION_BACKGROUND, animationCameras, animationFrames, animationParts, animationStyle, fitPoints, turnDirection } from "./animation";
import type { ScenePart } from "./model";

describe("animationFrames", () => {
  const frames = animationFrames(10, { hold: 1, explode: 1, pause: 0.5, turn: 2 });

  it("goes assembled, apart, once round, and back together, in that order", () => {
    const phases = frames.map(f => f.phase).filter((p, i, a) => p !== a[i - 1]);
    expect(phases).toEqual(["hold", "explode", "pause", "turn", "rest", "together"]);
    expect(frames[0]).toMatchObject({ explode: 0, turn: 0, delay: 1000 });
    expect(frames.find(f => f.phase === "pause")).toMatchObject({ explode: 1, turn: 0, delay: 500 });
  });

  it("comes apart smoothly to fully apart, and goes back together the same way", () => {
    const out = frames.filter(f => f.phase === "explode").map(f => f.explode);
    expect(out.length).toBe(10);
    expect(out[out.length - 1]).toBe(1);
    out.slice(1).forEach((e, i) => expect(e).toBeGreaterThan(out[i]));
    const back = frames.filter(f => f.phase === "together").map(f => f.explode);
    // Back down, short of assembled: the loop's first frame is that.
    expect(back).toEqual(out.slice(0, -1).reverse());
  });

  it("turns once round without showing the start twice", () => {
    const turns = frames.filter(f => f.phase === "turn").map(f => f.turn);
    expect(turns.length).toBe(19);
    expect(Math.min(...turns)).toBeGreaterThan(0);
    expect(Math.max(...turns)).toBeLessThan(1);
    turns.slice(1).forEach((t, i) => expect(t).toBeGreaterThan(turns[i]));
    expect(frames.filter(f => f.phase === "turn").every(f => f.explode === 1)).toBe(true);
  });
});

describe("turnDirection", () => {
  it("turns the view about the up axis, keeping its height", () => {
    const d = turnDirection([1, 0, 0.5], 0.25);
    expect(d.map(v => Math.round(v * 1000) / 1000 + 0)).toEqual([0, 1, 0.5]);
    expect(turnDirection([1, -1, 1], 1).map(v => Math.round(v * 1000) / 1000 + 0)).toEqual([1, -1, 1]);
  });
});

describe("fitPoints", () => {
  const box = (x: number, y: number, z: number, s = 10) => {
    const out: number[] = [];
    for (let i = 0; i < 8; i++) out.push(x + (i & 1 ? s : -s), y + (i & 2 ? s : -s), z + (i & 4 ? s : -s));
    return new Float32Array(out);
  };

  it("centres on the points and fits them", () => {
    const cam = fitPoints([0, -1, 0], box(100, 0, 50), 1, 1);
    expect(cam.target[0]).toBeCloseTo(100);
    expect(cam.target[2]).toBeCloseTo(50);
    expect(cam.size).toBeCloseTo(10);
  });

  it("about a given point, takes in the far side", () => {
    const cam = fitPoints([0, -1, 0], box(100, 0, 0), 1, 1, [80, 0, 0]);
    expect(cam.target).toEqual([80, 0, 0]);
    expect(cam.size).toBeCloseTo(30);
  });

  it("allows for a wide picture", () => {
    expect(fitPoints([0, -1, 0], box(0, 0, 0), 2, 1).size).toBeCloseTo(10);
    expect(fitPoints([0, -1, 0], box(0, 0, 0), 0.5, 1).size).toBeCloseTo(20);
  });
});

describe("animationCameras", () => {
  // Two cubes that move apart along X as it explodes.
  const pointsAt = (e: number) => {
    const out: number[] = [];
    for (const cx of [-5 - 40 * e, 5 + 40 * e]) for (let i = 0; i < 8; i++) out.push(cx + (i & 1 ? 5 : -5), i & 2 ? 5 : -5, i & 4 ? 5 : -5);
    return new Float32Array(out);
  };
  const frames = animationFrames(10, { hold: 1, explode: 1, pause: 0.5, turn: 2 });
  const cams = animationCameras(frames, [0, -1, 0.3], pointsAt, 4 / 3, 1);

  it("fits the assembled model tightly, and grows as it comes apart", () => {
    const sizes = frames.map((f, i) => ({ f, s: cams[i].size })).filter(x => x.f.phase === "explode" || x.f.phase === "hold").map(x => x.s);
    sizes.slice(1).forEach((s, i) => expect(s).toBeGreaterThanOrEqual(sizes[i] - 1e-6));
    expect(cams[0].size).toBeLessThan(sizes[sizes.length - 1] / 2);
  });

  it("holds the same size and centre for the whole turn", () => {
    const turn = cams.filter((_, i) => frames[i].explode === 1);
    expect(new Set(turn.map(c => c.size.toFixed(6))).size).toBe(1);
    expect(new Set(turn.map(c => c.target.map(v => v.toFixed(6)).join()))).toHaveProperty("size", 1);
    // Big enough for the model end on, a quarter of the way round.
    const quarter = cams[frames.findIndex(f => f.phase === "turn" && f.turn >= 0.25)];
    expect(quarter.size).toBeGreaterThanOrEqual(fitPoints(quarter.direction, pointsAt(1), 4 / 3, 1, quarter.target).size - 1e-6);
  });
});

describe("animationParts", () => {
  it("shows every part the model shows, none ghosted, picked out or set apart on its own", () => {
    const parts: ScenePart[] = [
      { id: "a", name: "A", position: [0, 0, 0], rotation: [0, 0, 0], ghost: true, highlight: true },
      { id: "b", name: "B", position: [0, 0, 0], rotation: [0, 0, 0], parent: "a", explode: 0, joint: { normal: [0, 0, 1], distance: 20, explodeDir: "+x" } },
      { id: "c", name: "C", position: [0, 0, 0], rotation: [0, 0, 0], hidden: true },
    ];
    const out = animationParts({ parts });
    expect(out.map(p => p.id)).toEqual(["a", "b"]);
    expect(out[0].ghost ?? out[0].highlight).toBeUndefined();
    expect(out[1].explode).toBeUndefined();
    // The joint's own "Comes off" way is kept.
    expect(out[1].joint?.explodeDir).toBe("+x");
  });

  it("leaves out the pieces tracks are made from, but keeps the tracks", () => {
    const parts: ScenePart[] = [
      { id: "chassis", name: "Chassis", position: [0, 0, 0], rotation: [0, 0, 0] },
      { id: "piece", name: "Track link", position: [0, -60, 0], rotation: [0, 0, 0] },
      { id: "piece2", name: "Track link", position: [0, 60, 0], rotation: [0, 0, 0] },
      { id: "left", name: "Track", position: [0, 0, 0], rotation: [0, 0, 0], parent: "chassis", track: { link: "piece" } as ScenePart["track"] },
      { id: "right", name: "Track", position: [0, 0, 0], rotation: [0, 0, 0], parent: "chassis", track: { link: "piece2" } as ScenePart["track"] },
    ];
    expect(animationParts({ parts }).map(p => p.id)).toEqual(["chassis", "left", "right"]);
  });

  it("sits on the Assembly step template's grey", async () => {
    const { TEMPLATES } = await import("../elements");
    expect(ANIMATION_BACKGROUND).toBe(TEMPLATES.find(t => t.id === "assembly")!.background);
  });

  it("draws without draft lines", () => {
    expect(animationStyle().draft).toBe(false);
  });
});
