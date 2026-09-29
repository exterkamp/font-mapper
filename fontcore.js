// Core raster-to-font logic: binarize a scanned glyph cell, trace its ink
// boundary into polygon contours (outer + holes, correctly wound, no
// separate hole-detection pass needed), simplify, and assemble an opentype.js
// font from the results. Pure logic, no DOM/canvas access, so it can run
// identically in the browser or under plain Node (see test/test-fontcore.js).
(function (root) {
  const UNITS_PER_EM = 1000;
  const BOX_TOP = 720; // font units above baseline reserved for the drawing box - must match Layout's BASELINE_FRACTION
  const BOX_BOTTOM = -280; // font units below baseline (descender room)
  const DEFAULT_SIDE_BEARING = 60; // 6% of em, applied both sides of the ink when auto-sizing
  const SPACE_ADVANCE = 500;

  function toBinaryBitmap(imageData, threshold) {
    const { data, width, height } = imageData;
    const bitmap = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      bitmap[i] = lum <= threshold ? 1 : 0;
    }
    return bitmap;
  }

  // Directed unit-edge boundary trace. Each foreground pixel contributes an
  // edge wherever its neighbor across that side is background. Edges are
  // oriented so that following them keeps foreground consistently on one
  // side; chaining them into closed loops yields outer contours and hole
  // contours with automatically-opposite winding.
  function traceContours(bitmap, w, h) {
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bitmap[y * w + x]);
    const starts = new Map();
    const push = (x1, y1, x2, y2) => {
      const k = x1 + "," + y1;
      if (!starts.has(k)) starts.set(k, []);
      starts.get(k).push({ x: x2, y: y2 });
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!at(x, y)) continue;
        if (!at(x, y - 1)) push(x, y, x + 1, y);
        if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);
        if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);
        if (!at(x - 1, y)) push(x, y + 1, x, y);
      }
    }
    const contours = [];
    for (const startKey of Array.from(starts.keys())) {
      let stack = starts.get(startKey);
      while (stack && stack.length) {
        const [sx, sy] = startKey.split(",").map(Number);
        const startPt = { x: sx, y: sy };
        const points = [startPt];
        let current = startPt;
        for (;;) {
          const key = current.x + "," + current.y;
          const s = starts.get(key);
          if (!s || !s.length) break;
          const next = s.pop();
          if (next.x === startPt.x && next.y === startPt.y) break;
          points.push(next);
          current = next;
        }
        if (points.length >= 3) contours.push(points);
        stack = starts.get(startKey);
      }
    }
    return contours;
  }

  function pointLineDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function rdp(points, epsilon) {
    if (points.length < 3) return points.slice();
    let maxDist = 0;
    let index = 0;
    const a = points[0];
    const b = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) {
      const d = pointLineDist(points[i], a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon) {
      const left = rdp(points.slice(0, index + 1), epsilon);
      const right = rdp(points.slice(index), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  function simplifyContours(contours, epsilon) {
    return contours.map((c) => rdp(c, epsilon)).filter((c) => c.length >= 3);
  }

  // Map contours (in bitmap grid-corner coords, [0,gridWidth]x[0,gridHeight])
  // into an opentype.js Path in font units, using a fixed box->em mapping so
  // every glyph's drawing box lands at the same baseline. unitsPerEmWidth is
  // how many font units the grid's full width represents - UNITS_PER_EM for
  // a normal square single-letter box, or proportionally more for a wider
  // ligature box, so physical inches stay the same scale everywhere. xShift
  // repositions the glyph horizontally (e.g. to seat it against a chosen
  // left bearing).
  function contoursToPath(otLib, contours, gridWidth, gridHeight, unitsPerEmWidth, xShift) {
    const emWidth = unitsPerEmWidth == null ? UNITS_PER_EM : unitsPerEmWidth;
    const path = new otLib.Path();
    const boxH = BOX_TOP - BOX_BOTTOM;
    const dx = xShift || 0;
    for (const contour of contours) {
      contour.forEach((pt, i) => {
        const fx = (pt.x / gridWidth) * emWidth + dx;
        const fy = BOX_TOP - (pt.y / gridHeight) * boxH;
        if (i === 0) path.moveTo(fx, fy);
        else path.lineTo(fx, fy);
      });
      path.close();
    }
    return path;
  }

  // Ink bounding box, in font-unit X only (box->em mapping, no shift applied).
  function inkBBoxX(contours, gridWidth, unitsPerEmWidth) {
    const emWidth = unitsPerEmWidth == null ? UNITS_PER_EM : unitsPerEmWidth;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const contour of contours) {
      for (const pt of contour) {
        const fx = (pt.x / gridWidth) * emWidth;
        if (fx < minX) minX = fx;
        if (fx > maxX) maxX = fx;
      }
    }
    return { minX, maxX };
  }

  // Auto-scanned spacing: advance width sized to the actual ink extent plus a
  // side bearing on each side, instead of every glyph claiming the full em box
  // regardless of how much of it it actually uses.
  function naturalMetrics(contours, gridWidth, unitsPerEmWidth, sideBearing) {
    const bearing = sideBearing == null ? DEFAULT_SIDE_BEARING : sideBearing;
    const { minX, maxX } = inkBBoxX(contours, gridWidth, unitsPerEmWidth);
    const inkWidth = Math.max(0, maxX - minX);
    return {
      inkMinX: minX,
      inkMaxX: maxX,
      leftBearing: bearing,
      advanceWidth: Math.round(inkWidth + 2 * bearing),
    };
  }

  function buildGlyph(otLib, { name, unicode, contours, gridWidth, gridHeight, unitsPerEmWidth, leftBearing, advanceWidth }) {
    const { minX } = inkBBoxX(contours, gridWidth, unitsPerEmWidth);
    const shift = contours.length ? leftBearing - minX : 0;
    const path = contoursToPath(otLib, contours, gridWidth, gridHeight, unitsPerEmWidth, shift);
    return new otLib.Glyph({
      name,
      unicode,
      advanceWidth,
      path,
    });
  }

  function buildFont(otLib, glyphDefs, { familyName, styleName, spaceAdvanceWidth }) {
    const notdefPath = new otLib.Path();
    const notdef = new otLib.Glyph({
      name: ".notdef",
      advanceWidth: spaceAdvanceWidth || SPACE_ADVANCE,
      path: notdefPath,
    });
    const space = new otLib.Glyph({
      name: "space",
      unicode: 32,
      advanceWidth: spaceAdvanceWidth || SPACE_ADVANCE,
      path: new otLib.Path(),
    });
    const glyphs = [notdef, space, ...glyphDefs.map((g) => buildGlyph(otLib, g))];
    return new otLib.Font({
      familyName: familyName || "HandFont",
      styleName: styleName || "Regular",
      unitsPerEm: UNITS_PER_EM,
      ascender: BOX_TOP,
      descender: BOX_BOTTOM,
      glyphs,
    });
  }

  // Wires a ligature glyph into the standard "liga" GSUB feature so typing
  // the component letters in sequence (e.g. "t" then "h") substitutes in the
  // single drawn ligature glyph, under both DFLT and latn scripts since
  // different text shapers pick one or the other for plain English text.
  function addLigatureSubstitution(font, componentGids, ligatureGid) {
    ["DFLT", "latn"].forEach((script) => {
      font.substitution.add("liga", { sub: componentGids, by: ligatureGid }, script, "dflt");
    });
  }

  const FontCore = {
    UNITS_PER_EM,
    BOX_TOP,
    BOX_BOTTOM,
    DEFAULT_SIDE_BEARING,
    SPACE_ADVANCE,
    toBinaryBitmap,
    traceContours,
    simplifyContours,
    contoursToPath,
    inkBBoxX,
    naturalMetrics,
    buildGlyph,
    buildFont,
    addLigatureSubstitution,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = FontCore;
  } else {
    root.FontCore = FontCore;
  }
})(typeof window !== "undefined" ? window : globalThis);
