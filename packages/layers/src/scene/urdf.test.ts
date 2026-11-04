import { describe, expect, it } from "vitest";
import { applyJoint } from "./joint";
import type { ScenePart } from "./model";
import { normalizeScene } from "./model";
import { crc32, toUrdf, urdfName, zip } from "./urdf";

const attr = (xml: string, tag: string, name: string, at = 0) => {
  const re = new RegExp(`<${tag}[^>]*\\b${name}="([^"]*)"`, "g");
  const all = [...xml.matchAll(re)].map(m => m[1]);
  return all[at];
};
const nums = (s: string) => s.split(" ").map(Number);

function part(over: Partial<ScenePart>): ScenePart {
  return { id: "a", name: "Base", url: "/m/base.stl", position: [0, 0, 0], rotation: [0, 0, 0], ...over } as ScenePart;
}

describe("urdfName", () => {
  it("makes safe names", () => {
    expect(urdfName("Servo Horn.STL")).toBe("servo_horn");
    expect(urdfName("***")).toBe("part");
  });
});

describe("toUrdf", () => {
  it("hangs a loose part off base_link at its place, in metres", () => {
    const { urdf, meshes } = toUrdf("My Robot", [part({ position: [10, 20, 30], rotation: [0, 0, 90] })]);
    expect(urdf).toContain('<robot name="my_robot">');
    expect(urdf).toContain('<link name="base_link"/>');
    expect(urdf).toContain('<mesh filename="meshes/base.stl" scale="0.001 0.001 0.001"/>');
    expect(urdf).toContain('<joint name="base_joint" type="fixed">');
    expect(urdf).toContain('<origin xyz="0.01 0.02 0.03" rpy="0 0 1.570796"/>');
    expect(meshes).toEqual([{ path: "meshes/base.stl", partId: "a" }]);
  });

  it("shares one mesh between copies and keeps names unique", () => {
    const { urdf, meshes } = toUrdf("r", [part({ id: "a", name: "Screw" }), part({ id: "b", name: "Screw" })]);
    expect(meshes).toHaveLength(1);
    expect(urdf).toContain('<link name="screw">');
    expect(urdf).toContain('<link name="screw_2">');
  });

  it("writes a turning joint at its point with axis and limits", () => {
    // A horn on top of a 20 mm cube: horn bottom (0,0,-2) meets cube top (0,0,10).
    const horn = part({
      id: "h",
      name: "Horn",
      url: "/m/horn.stl",
      parent: "a",
      joint: { normal: [0, 0, 1], distance: 0, point: [0, 0, 10], childPoint: [0, 0, -2], childNormal: [0, 0, -1], spin: 30, gap: 0, type: "revolute", lower: -90, upper: 45 },
    });
    applyJoint(horn);
    const { urdf } = toUrdf("r", [part({}), horn]);
    const j = urdf.slice(urdf.indexOf('<joint name="horn_joint"'));
    expect(j).toContain('type="revolute"');
    expect(j).toContain('<parent link="base"/>');
    // The joint frame sits on the cube's top face, unspun.
    expect(nums(attr(j, "origin", "xyz"))).toEqual([0, 0, 0.01]);
    expect(nums(attr(j, "origin", "rpy"))).toEqual([0, 0, 0]);
    expect(nums(attr(j, "axis", "xyz"))).toEqual([0, 0, 1]);
    expect(attr(j, "limit", "lower")).toBe("-1.570796");
    expect(attr(j, "limit", "upper")).toBe("0.785398");
    // The horn's mesh hangs from its joint point.
    const l = urdf.slice(urdf.indexOf('<link name="horn">'));
    expect(nums(attr(l, "origin", "xyz"))).toEqual([0, 0, 0.002]);
  });

  it("writes a sliding joint in metres, at no gap", () => {
    const drawer = part({
      id: "d",
      name: "Drawer",
      parent: "a",
      joint: { normal: [1, 0, 0], distance: 0, point: [10, 0, 0], childPoint: [-5, 0, 0], childNormal: [-1, 0, 0], spin: 0, gap: 8, type: "prismatic", lower: 0, upper: 20 },
    });
    applyJoint(drawer);
    const { urdf } = toUrdf("r", [part({}), drawer]);
    const j = urdf.slice(urdf.indexOf('<joint name="drawer_joint"'));
    expect(j).toContain('type="prismatic"');
    expect(nums(attr(j, "origin", "xyz"))).toEqual([0.01, 0, 0]);
    expect(nums(attr(j, "axis", "xyz"))).toEqual([1, 0, 0]);
    expect(attr(j, "limit", "upper")).toBe("0.02");
  });
});

describe("joint types in normalizeScene", () => {
  it("keeps moving joints' limits in order and drops them on fixed joints", () => {
    const s = normalizeScene({
      parts: [
        { id: "a" },
        { id: "b", parent: "a", joint: { normal: [0, 0, 1], distance: 0, type: "revolute", lower: 400, upper: -30 } },
        { id: "c", parent: "a", joint: { normal: [0, 0, 1], distance: 0, type: "fixed", lower: 1, upper: 2 } },
        { id: "d", parent: "a", joint: { normal: [0, 0, 1], distance: 0, type: "prismatic" } },
      ],
    });
    expect(s.parts[1].joint).toMatchObject({ type: "revolute", lower: -30, upper: 180 });
    expect(s.parts[2].joint!.type).toBeUndefined();
    expect(s.parts[2].joint!.lower).toBeUndefined();
    expect(s.parts[3].joint).toMatchObject({ type: "prismatic", lower: 0, upper: 20 });
  });
});

describe("zip", () => {
  it("makes a stored zip with the right signatures and CRCs", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const z = zip([{ name: "robot.urdf", data: new TextEncoder().encode("<robot/>") }, { name: "meshes/a.stl", data: new Uint8Array(84) }]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(z.length - 12, true)).toBe(2);
  });
});
