// A 3D scene on the page: the picture last drawn from the scene, carrying
// the scene itself (parts, camera, style) so it can be opened and changed.
// The picture is drawn `pictureScale` times the layer's page size, for
// sharpness; the layer shows it at its page size.

import { classRegistry, FabricImage } from "fabric";
import type { SceneData } from "./scene/model";

export interface DetailInfo {
  of: string;
  part?: string;
  spot?: { x: number; y: number };
  zoom?: number;
  label?: boolean;
}

export class SceneLayer extends FabricImage {
  static type = "SceneLayer";
  static customProperties = ["scene", "pictureScale", "detail"];

  declare scene?: SceneData;
  declare pictureScale?: number;
  /**
   * A detail circle: a magnifier on another scene layer (`of` is its
   * layerId), centred on `spot` (fractions across and down that picture)
   * at `zoom` times its scale, drawn on a white disc with a ring. `part` is
   * drawn whole over the ring (the part under the spot, or one chosen);
   * `label` false hides the "2x" box on the ring.
   */
  declare detail?: DetailInfo;

  /** The layer's size on the page. */
  pageSize(): { w: number; h: number } {
    return { w: Math.max(1, (this.width || 1) * Math.abs(this.scaleX || 1)), h: Math.max(1, (this.height || 1) * Math.abs(this.scaleY || 1)) };
  }
}

classRegistry.setClass(SceneLayer);
classRegistry.setClass(SceneLayer, "scenelayer");

export const isScene = (o: unknown): o is SceneLayer => o instanceof SceneLayer;
/** A detail circle (a close-up of one part of another scene). */
export const isDetail = (o: unknown): o is SceneLayer & { detail: DetailInfo } => o instanceof SceneLayer && !!o.detail;

/** A see-through stand-in picture for a scene not drawn yet. */
export function placeholderPicture(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.strokeStyle = "rgba(31, 35, 40, 0.35)";
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, c.width - 2, c.height - 2);
    ctx.setLineDash([]);
    // A cube, as on the Elements tile.
    const s = Math.min(c.width, c.height) * 0.16;
    const x = c.width / 2;
    const y = c.height / 2 - s * 0.35;
    ctx.lineWidth = Math.max(2, s / 14);
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s, y - s / 2);
    ctx.lineTo(x + s, y + s / 2);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s, y + s / 2);
    ctx.lineTo(x - s, y - s / 2);
    ctx.closePath();
    ctx.moveTo(x - s, y - s / 2);
    ctx.lineTo(x, y);
    ctx.lineTo(x + s, y - s / 2);
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + s);
    ctx.stroke();
    ctx.fillStyle = "rgba(31, 35, 40, 0.6)";
    ctx.font = `600 ${Math.max(14, Math.round(s * 0.32))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Double-click to add 3D parts", x, y + s * 1.75);
  }
  return c;
}
