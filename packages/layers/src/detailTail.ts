// The tail of a detail circle, as on a flat-pack sheet: two lines that
// leave the ring and curve in to a point on the picture, the spot the
// circle magnifies. It's a connector, so its tip is dragged like a line's
// end; its start is kept at the circle's middle by the editor, which also
// sets `radius` (the ring's, on the page). Drawn over the circle, its white
// fill breaks the ring where it leaves. (The outline its tip touches is
// broken in the picture itself: the editor cuts the spot back to the fills.)

import { classRegistry } from "fabric";
import { Connector } from "./connector";

/** How a detail circle is joined to its spot: a flared tail (flat-pack sheets), a thin straight line (brick sets), or nothing. */
export type TailLook = "tail" | "line" | "none";
export const TAIL_LOOKS: { id: TailLook; label: string; detail: string }[] = [
  { id: "tail", label: "Tail", detail: "A flared tail from the ring to the spot, as on a flat-pack sheet" },
  { id: "line", label: "Line", detail: "A thin straight line from the ring to the spot, as in a brick set" },
  { id: "none", label: "None", detail: "The circle alone" },
];

export class DetailTail extends Connector {
  static type = "DetailTail";
  static customProperties = [...Connector.customProperties, "radius", "detailOf", "look"];

  declare radius?: number;
  declare detailOf?: string;
  declare look?: TailLook;

  _render(ctx: CanvasRenderingContext2D): void {
    const p = this.calcLinePoints();
    const r = Number(this.radius) || 0;
    const dx = p.x2 - p.x1;
    const dy = p.y2 - p.y1;
    const len = Math.hypot(dx, dy);
    const sw = Number(this.strokeWidth) || 1;
    if (!r || len <= r + sw * 2 || this.look === "none") return;
    const a = Math.atan2(dy, dx);
    if (this.look === "line") {
      // A thin line from the ring's edge to the spot.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p.x1 + r * Math.cos(a), p.y1 + r * Math.sin(a));
      ctx.lineTo(p.x2, p.y2);
      ctx.lineWidth = Math.max(1, sw * 0.5);
      ctx.lineCap = "round";
      ctx.strokeStyle = typeof this.stroke === "string" ? this.stroke : "#000";
      ctx.stroke();
      ctx.restore();
      return;
    }
    // How wide the tail is where it leaves the ring, and how far it curves out before heading in.
    const th = Math.min(0.3, Math.max(0.12, (r * 0.2) / Math.max(1, len - r)));
    const A = { x: p.x1 + r * Math.cos(a - th), y: p.y1 + r * Math.sin(a - th) };
    const B = { x: p.x1 + r * Math.cos(a + th), y: p.y1 + r * Math.sin(a + th) };
    const reach = len - r;
    // Each line leaves the ring square on and bends in to the tip: the control point sits out along the ring's normal.
    const out = Math.min(r * 0.6, reach * 0.45);
    const cA = { x: A.x + Math.cos(a - th) * out, y: A.y + Math.sin(a - th) * out };
    const cB = { x: B.x + Math.cos(a + th) * out, y: B.y + Math.sin(a + th) * out };
    const colour = typeof this.stroke === "string" ? this.stroke : "#000";
    ctx.save();
    // White inside the tail, over the ring's segment between the two lines.
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.quadraticCurveTo(cA.x, cA.y, p.x2, p.y2);
    ctx.quadraticCurveTo(cB.x, cB.y, B.x, B.y);
    ctx.arc(p.x1, p.y1, r - sw, a + th, a - th, true);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.quadraticCurveTo(cA.x, cA.y, p.x2, p.y2);
    ctx.quadraticCurveTo(cB.x, cB.y, B.x, B.y);
    ctx.lineWidth = sw;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = colour;
    ctx.stroke();
    ctx.restore();
  }
}

classRegistry.setClass(DetailTail);
classRegistry.setClass(DetailTail, "detailtail");

export const isTail = (o: unknown): o is DetailTail => o instanceof DetailTail;
