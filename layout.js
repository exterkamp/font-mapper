// Shared template layout config. Used by both the template renderer (app.js)
// and the scan/dewarp step, so cell positions are always derived the same way.
(function (root) {
  const PAGE_IN = { width: 8.5, height: 11, margin: 0.5 };
  const CELL_IN = { size: 0.85, gap: 0.1 };
  const LABEL_STRIP_IN = 0.12; // reserved strip above the box for the label - kept fully outside the drawing area
  const BASELINE_FRACTION = 0.72; // from the top of the box, must match FontCore's BOX_TOP/(BOX_TOP-BOX_BOTTOM) - lower than a typical printed font's cap-height ratio, deliberately, so descenders (g/j/p/q/y) have real room instead of running past the box
  const BASELINE_TICK_IN = 0.05; // tick length, drawn in the gap outside the box's left/right edges
  const MARK_IN = 0.45; // registration square size
  const GRID_INSET_IN = 0.35; // gap between registration marks and first cell
  const VDPI = 150; // virtual DPI for the dewarped working canvas

  // Every page carries a QR code identifying itself: kind + the exact,
  // ordered token list printed on it. This makes each scan self-describing -
  // upload order doesn't matter, and a page keeps working even if the live
  // charset/ligature fields have since been edited, because the app reads
  // what's actually printed rather than trusting current UI state.
  const QR_SIZE_IN = 1.0;
  const QR_BAND_IN = 1.3; // vertical space reserved for the QR, pushes the grid down
  const QR_SEP = String.fromCharCode(31); // ASCII unit separator - won't collide with real characters

  function qrRectIn() {
    const c = contentBox();
    return {
      x: c.x + c.w / 2 - QR_SIZE_IN / 2,
      y: c.y + QR_BAND_IN / 2 - QR_SIZE_IN / 2,
      w: QR_SIZE_IN,
      h: QR_SIZE_IN,
    };
  }

  function qrPayloadFor(pageDescriptor) {
    const kindChar = pageDescriptor.kind === "ligature" ? "L" : "C";
    return kindChar + QR_SEP + pageDescriptor.tokens.join(QR_SEP);
  }

  function parseQrPayload(payload) {
    const parts = payload.split(QR_SEP);
    const kind = parts[0] === "L" ? "ligature" : "chars";
    const tokens = parts.slice(1).filter((t) => t.length > 0);
    return { kind, tokens };
  }

  // Each corner marker is a solid black square with a distinct number of small
  // punched-out holes (0/1/2/3), so it can be identified by topology alone
  // (contour count) regardless of how the photo is rotated or skewed - the
  // same trick QR codes use 3 identical + 1 different finder pattern for,
  // done here by shape instead of position so auto-detection needs no
  // decoding, just the contour tracer already used for glyphs.
  const MARK_HOLE_COUNTS = { tl: 0, tr: 1, bl: 2, br: 3 };

  function markHoleOffsets(n) {
    const spacing = MARK_IN * 0.28;
    if (n <= 0) return [];
    if (n === 1) return [0];
    if (n === 2) return [-0.5 * spacing, 0.5 * spacing];
    return [-spacing, 0, spacing];
  }

  // Hole squares (in absolute page inches) for a marker centered at (cx, cy).
  function markHoleRectsIn(cx, cy, holeCount) {
    const holeSize = MARK_IN * 0.22;
    return markHoleOffsets(holeCount).map((dx) => ({
      x: cx + dx - holeSize / 2,
      y: cy - holeSize / 2,
      w: holeSize,
      h: holeSize,
    }));
  }

  const DEFAULT_CHARS = Array.from(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?'\"-:;()"
  );

  // Ligature cells are wider (need room for 2-3 connected letters) but the
  // same height as regular cells, so they get their own grid on their own
  // page(s) rather than being packed into leftover space in the letter grid.
  const LIGATURE_CELL_IN = { width: CELL_IN.size * 1.8, height: CELL_IN.size };
  const DEFAULT_LIGATURES = ["th", "fi", "fl", "ff", "ffi", "ffl", "st", "ct"];

  function contentBox() {
    return {
      x: PAGE_IN.margin,
      y: PAGE_IN.margin,
      w: PAGE_IN.width - 2 * PAGE_IN.margin,
      h: PAGE_IN.height - 2 * PAGE_IN.margin,
    };
  }

  function gridBox() {
    const c = contentBox();
    return {
      x: c.x + GRID_INSET_IN,
      y: c.y + QR_BAND_IN + GRID_INSET_IN,
      w: c.w - 2 * GRID_INSET_IN,
      h: c.h - QR_BAND_IN - 2 * GRID_INSET_IN,
    };
  }

  function computeGrid() {
    const g = gridBox();
    const pitchW = CELL_IN.size + CELL_IN.gap;
    const pitchH = CELL_IN.size + LABEL_STRIP_IN + CELL_IN.gap;
    const cols = Math.max(1, Math.floor((g.w + CELL_IN.gap) / pitchW));
    const rows = Math.max(1, Math.floor((g.h + CELL_IN.gap) / pitchH));
    return { cols, rows };
  }

  // Registration marks sit at the 4 corners of contentBox(), centered exactly on the corner point.
  function registrationMarks() {
    const c = contentBox();
    const corners = [
      { key: "tl", x: c.x, y: c.y },
      { key: "tr", x: c.x + c.w, y: c.y },
      { key: "bl", x: c.x, y: c.y + c.h },
      { key: "br", x: c.x + c.w, y: c.y + c.h },
    ];
    return corners.map((m) => ({ ...m, holes: MARK_HOLE_COUNTS[m.key] }));
  }

  // The drawing box only - label and baseline guides live outside this rect entirely.
  function cellRectIn(index) {
    const { cols } = computeGrid();
    const g = gridBox();
    const pitchW = CELL_IN.size + CELL_IN.gap;
    const pitchH = CELL_IN.size + LABEL_STRIP_IN + CELL_IN.gap;
    const row = Math.floor(index / cols);
    const col = index % cols;
    return {
      x: g.x + col * pitchW,
      y: g.y + row * pitchH + LABEL_STRIP_IN,
      w: CELL_IN.size,
      h: CELL_IN.size,
    };
  }

  // The label strip sits directly above the box, in space the box never occupies.
  function labelRectIn(index) {
    const box = cellRectIn(index);
    return { x: box.x, y: box.y - LABEL_STRIP_IN, w: box.w, h: LABEL_STRIP_IN };
  }

  // Baseline reference as two short ticks in the gap just outside the box's
  // left/right edges, instead of a line drawn across the writing area.
  function baselineTicksIn(index) {
    const box = cellRectIn(index);
    const y = box.y + box.h * BASELINE_FRACTION;
    return [
      { x1: box.x - BASELINE_TICK_IN, y1: y, x2: box.x, y2: y },
      { x1: box.x + box.w, y1: y, x2: box.x + box.w + BASELINE_TICK_IN, y2: y },
    ];
  }

  function buildPages(chars) {
    const { cols, rows } = computeGrid();
    const perPage = cols * rows;
    const pages = [];
    for (let i = 0; i < chars.length; i += perPage) {
      pages.push(chars.slice(i, i + perPage));
    }
    return pages;
  }

  function computeLigatureGrid() {
    const g = gridBox();
    const pitchW = LIGATURE_CELL_IN.width + CELL_IN.gap;
    const pitchH = LIGATURE_CELL_IN.height + LABEL_STRIP_IN + CELL_IN.gap;
    const cols = Math.max(1, Math.floor((g.w + CELL_IN.gap) / pitchW));
    const rows = Math.max(1, Math.floor((g.h + CELL_IN.gap) / pitchH));
    return { cols, rows };
  }

  function ligatureCellRectIn(index) {
    const { cols } = computeLigatureGrid();
    const g = gridBox();
    const pitchW = LIGATURE_CELL_IN.width + CELL_IN.gap;
    const pitchH = LIGATURE_CELL_IN.height + LABEL_STRIP_IN + CELL_IN.gap;
    const row = Math.floor(index / cols);
    const col = index % cols;
    return {
      x: g.x + col * pitchW,
      y: g.y + row * pitchH + LABEL_STRIP_IN,
      w: LIGATURE_CELL_IN.width,
      h: LIGATURE_CELL_IN.height,
    };
  }

  function ligatureLabelRectIn(index) {
    const box = ligatureCellRectIn(index);
    return { x: box.x, y: box.y - LABEL_STRIP_IN, w: box.w, h: LABEL_STRIP_IN };
  }

  function ligatureBaselineTicksIn(index) {
    const box = ligatureCellRectIn(index);
    const y = box.y + box.h * BASELINE_FRACTION;
    return [
      { x1: box.x - BASELINE_TICK_IN, y1: y, x2: box.x, y2: y },
      { x1: box.x + box.w, y1: y, x2: box.x + box.w + BASELINE_TICK_IN, y2: y },
    ];
  }

  function buildLigaturePages(ligatures) {
    const { cols, rows } = computeLigatureGrid();
    const perPage = cols * rows;
    const pages = [];
    for (let i = 0; i < ligatures.length; i += perPage) {
      pages.push(ligatures.slice(i, i + perPage));
    }
    return pages;
  }

  // Full template: homogeneous pages of single letters first, then
  // homogeneous pages of (wider) ligature cells. Each page is one kind or
  // the other, never mixed, so every page has one consistent grid to reason
  // about downstream (rendering, cropping, tracing).
  function buildTemplatePages(chars, ligatures) {
    const charPages = buildPages(chars).map((tokens) => ({ kind: "chars", tokens }));
    const ligaturePages = buildLigaturePages(ligatures || []).map((tokens) => ({ kind: "ligature", tokens }));
    return charPages.concat(ligaturePages);
  }

  function canonicalLigatureCellRectPx(index) {
    const r = ligatureCellRectIn(index);
    return {
      x: inToPx(r.x),
      y: inToPx(r.y),
      w: inToPx(r.w),
      h: inToPx(r.h),
    };
  }

  function inToPx(inches) {
    return Math.round(inches * VDPI);
  }

  // Canonical destination coordinates (in VDPI px) for the 4 registration marks,
  // in the fixed order tl, tr, bl, br. This is the target rectangle every scan
  // gets warped into.
  function canonicalMarkPoints() {
    return registrationMarks().map((m) => ({
      key: m.key,
      x: inToPx(m.x),
      y: inToPx(m.y),
      holes: m.holes,
    }));
  }

  // Hole squares for a marker, in canonical VDPI px, for the given center (px) and hole count.
  function markHoleRectsPx(cx, cy, holeCount) {
    return markHoleRectsIn(cx / VDPI, cy / VDPI, holeCount).map((r) => ({
      x: inToPx(r.x),
      y: inToPx(r.y),
      w: inToPx(r.w),
      h: inToPx(r.h),
    }));
  }

  function canonicalCellRectPx(index) {
    const r = cellRectIn(index);
    return {
      x: inToPx(r.x),
      y: inToPx(r.y),
      w: inToPx(r.w),
      h: inToPx(r.h),
    };
  }

  function canonicalPageSizePx() {
    return { w: inToPx(PAGE_IN.width), h: inToPx(PAGE_IN.height) };
  }

  const Layout = {
    PAGE_IN,
    CELL_IN,
    LABEL_STRIP_IN,
    BASELINE_FRACTION,
    BASELINE_TICK_IN,
    MARK_IN,
    MARK_HOLE_COUNTS,
    GRID_INSET_IN,
    VDPI,
    DEFAULT_CHARS,
    LIGATURE_CELL_IN,
    DEFAULT_LIGATURES,
    QR_SIZE_IN,
    QR_BAND_IN,
    qrRectIn,
    qrPayloadFor,
    parseQrPayload,
    contentBox,
    gridBox,
    computeGrid,
    registrationMarks,
    markHoleRectsIn,
    markHoleRectsPx,
    cellRectIn,
    labelRectIn,
    baselineTicksIn,
    buildPages,
    computeLigatureGrid,
    ligatureCellRectIn,
    ligatureLabelRectIn,
    ligatureBaselineTicksIn,
    buildLigaturePages,
    buildTemplatePages,
    inToPx,
    canonicalMarkPoints,
    canonicalCellRectPx,
    canonicalLigatureCellRectPx,
    canonicalPageSizePx,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Layout;
  } else {
    root.Layout = Layout;
  }
})(typeof window !== "undefined" ? window : globalThis);
