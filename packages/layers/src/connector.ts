// Connector: a straight line or arrow whose ends can be fastened to the snap
// points of other layers, so it follows them when they move. Lines saved as
// plain Fabric `Line`s load as connectors too.

import { classRegistry, Line, Point, type TClassProperties } from "fabric";
import type { Side } from "./geometry";

/** What one end of a connector is fastened to: a layer, at one of its sides, or "auto" for whichever side faces the other end. */
export interface ConnectorEnd {
  id: string;
  side: Side | "auto";
}

export class Connector extends Line {
  static type = "Connector";
  static customProperties = ["arrowStart", "arrowEnd", "connFrom", "connTo"];

  declare arrowStart?: boolean;
  declare arrowEnd?: boolean;
  declare connFrom?: ConnectorEnd | null;
  declare connTo?: ConnectorEnd | null;

  constructor(points?: [number, number, number, number], options: Partial<TClassProperties<Connector>> = {}) {
    super(points, { objectCaching: false, ...options });
  }

  /** The two ends on the page, start first. */
  ends(): [Point, Point] {
    const p = this.calcLinePoints();
    const m = this.calcTransformMatrix();
    return [new Point(p.x1, p.y1).transform(m), new Point(p.x2, p.y2).transform(m)];
  }

  /** Moves the ends to `a` and `b` on the page. Only for a connector that isn't inside a group or selection. */
  setEnds(a: { x: number; y: number }, b: { x: number; y: number }): void {
    this.set({ angle: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 });
    this.set({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    this.setCoords();
  }

  _render(ctx: CanvasRenderingContext2D): void {
    super._render(ctx);
    if (!this.arrowStart && !this.arrowEnd) return;
    const p = this.calcLinePoints();
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
    if (len < 1) return;
    const sw = Number(this.strokeWidth) || 1;
    const head = Math.min(sw * 3 + 10, len * 0.45);
    const wing = 0.55; // radians either side of the line
    ctx.beginPath();
    const draw = (tx: number, ty: number, fx: number, fy: number) => {
      const a = Math.atan2(ty - fy, tx - fx);
      ctx.moveTo(tx - head * Math.cos(a - wing), ty - head * Math.sin(a - wing));
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - head * Math.cos(a + wing), ty - head * Math.sin(a + wing));
    };
    if (this.arrowEnd) draw(p.x2, p.y2, p.x1, p.y1);
    if (this.arrowStart) draw(p.x1, p.y1, p.x2, p.y2);
    // Arrow heads are always solid, even on a dashed line.
    const dash = this.strokeDashArray;
    this.strokeDashArray = null;
    ctx.lineWidth = sw;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (typeof this.stroke === "string") ctx.strokeStyle = this.stroke;
    if (this.stroke) this._renderStroke(ctx);
    this.strokeDashArray = dash;
  }
}

classRegistry.setClass(Connector);
// Plain lines from before connectors existed open as connectors.
classRegistry.setClass(Connector, "Line");
classRegistry.setClass(Connector, "line");

export const isConnector = (o: unknown): o is Connector => o instanceof Connector;
