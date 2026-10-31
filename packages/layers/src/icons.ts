// Line icons on a 24-unit grid, drawn with the current text colour.

const P: Record<string, string> = {
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  close: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  text: "M4 7V4h16v3M9 20h6M12 4v16",
  shapes: "M8.3 10a.7.7 0 0 1-.6-1L11.4 3a.7.7 0 0 1 1.2 0L16.3 9a.7.7 0 0 1-.6 1zM3 14h7v7H3zM17.5 21a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  image: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  layers: "m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5",
  paint: "M19 11V4a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v7zM5 11v2a2 2 0 0 0 2 2h3v4a2 2 0 0 0 4 0v-4h3a2 2 0 0 0 2-2v-2",
  template: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  copy: "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  unlock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 8 10 8a9.8 9.8 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2",
  bold: "M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z",
  italic: "M19 4h-9M14 20H5M15 4 9 20",
  underline: "M6 4v6a6 6 0 0 0 12 0V4M4 20h16",
  alignLeft: "M3 6h18M3 12h12M3 18h16",
  alignCenter: "M3 6h18M6 12h12M4 18h16",
  alignRight: "M3 6h18M9 12h12M5 18h16",
  forward: "M12 3v12M7 8l5-5 5 5M5 21h14",
  backward: "M12 21V9M7 16l5 5 5-5M5 3h14",
  position: "M5 9 2 12l3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  flipH: "M12 3v18M8 7 3 12l5 5zM16 7l5 5-5 5z",
  flipV: "M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z",
  group: "M3 3h8v8H3zM13 13h8v8h-8zM11 7h4a2 2 0 0 1 2 2v4",
  ungroup: "M3 3h8v8H3zM13 13h8v8h-8z",
  resize: "M21 9V3h-6M3 15v6h6M21 3l-7 7M3 21l7-7",
  opacity: "M12 2.7c3 3.4 6 6.5 6 10.3a6 6 0 0 1-12 0c0-3.8 3-6.9 6-10.3zM6 13h12",
  grip: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  background: "M3 3h18v18H3zM3 15l6-6 5 5 3-3 4 4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  dash: "M3 12h3M10.5 12h3M18 12h3",
  border: "M4 4h16v16H4z",
  rounded: "M4 20V10a6 6 0 0 1 6-6h10",
  highlight: "m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",
  spinner: "M21 12a9 9 0 1 1-6.2-8.6",
};

export type IconName = keyof typeof P;

export function icon(name: IconName | string, size = 18): string {
  const d = P[name] || P.more;
  return `<svg class="lyr-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
