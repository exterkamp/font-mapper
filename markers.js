// Auto-detects the 4 corner fiducial markers in a photographed/scanned
// template so alignment doesn't require manual dragging. Markers are plain
// black squares distinguished only by how many small holes are punched into
// them (0/1/2/3) - rotation/mirroring can't change that count, so identity
// survives any camera angle. Classification reuses FontCore.traceContours
// (same code that traces hand-drawn glyphs) rather than a separate pipeline.
(function (root) {
  function getFontCore() {
    if (typeof module !== "undefined" && module.exports) return require("./fontcore.js");
    return root.FontCore;
  }

  function otsuThreshold(imageData) {
    const { data, width, height } = imageData;
    const hist = new Array(256).fill(0);
    const total = width * height;
    for (let i = 0; i < total; i++) {
      const lum = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
      hist[lum]++;
    }
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, varMax = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > varMax) {
        varMax = varBetween;
        threshold = t;
      }
    }
    return threshold;
  }

  function connectedComponents(bitmap, w, h) {
    const visited = new Uint8Array(w * h);
    const components = [];
    const stackX = new Int32Array(w * h);
    const stackY = new Int32Array(w * h);
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const startIdx = sy * w + sx;
        if (!bitmap[startIdx] || visited[startIdx]) continue;
        let sp = 0;
        stackX[sp] = sx;
        stackY[sp] = sy;
        sp++;
        visited[startIdx] = 1;
        let minX = sx, maxX = sx, minY = sy, maxY = sy, area = 0;
        let sumX = 0, sumY = 0;
        while (sp > 0) {
          sp--;
          const x = stackX[sp];
          const y = stackY[sp];
          area++;
          sumX += x;
          sumY += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
          for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!bitmap[ni] || visited[ni]) continue;
            visited[ni] = 1;
            stackX[sp] = nx;
            stackY[sp] = ny;
            sp++;
          }
        }
        components.push({
          minX, maxX, minY, maxY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
          area,
          centroid: { x: sumX / area, y: sumY / area },
        });
      }
    }
    return components;
  }

  function cropBitmap(bitmap, w, h, box, pad) {
    const x0 = Math.max(0, box.minX - pad);
    const y0 = Math.max(0, box.minY - pad);
    const x1 = Math.min(w - 1, box.maxX + pad);
    const y1 = Math.min(h - 1, box.maxY + pad);
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const out = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        out[y * cw + x] = bitmap[(y0 + y) * w + (x0 + x)];
      }
    }
    return { data: out, width: cw, height: ch };
  }

  function contourBBoxArea(contour) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of contour) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return (maxX - minX) * (maxY - minY);
  }

  // Classify a candidate blob's hole count by tracing it in isolation.
  // Returns null if it doesn't look like a clean nested-square marker.
  function classifyHoleCount(bitmap, w, h, comp) {
    const FontCore = getFontCore();
    const crop = cropBitmap(bitmap, w, h, comp, 2);
    const contours = FontCore.traceContours(crop.data, crop.width, crop.height);
    if (!contours.length) return null;
    let outerIdx = 0;
    let outerArea = -1;
    contours.forEach((c, i) => {
      const a = contourBBoxArea(c);
      if (a > outerArea) {
        outerArea = a;
        outerIdx = i;
      }
    });
    const cropArea = crop.width * crop.height;
    if (outerArea < cropArea * 0.35) return null; // outer shape too small to be the marker body
    return contours.length - 1;
  }

  // A hand-drawn glyph can coincidentally match a marker's hole topology (an
  // "O" is a ring, just like the 1-hole marker). Markers are always printed
  // at the outer edge of the page, well outside the grid's inset margin, so
  // real markers must lie on the convex hull of all candidate blobs - any
  // look-alike ink blob sits inside the grid and won't.
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  const SIZE_FRAC_MIN = 0.15;
  const SIZE_FRAC_MAX = 7;
  const ASPECT_MIN = 0.55;
  const ASPECT_MAX = 1.8;

  // Finds the 4 corner markers in a full working-canvas ImageData.
  // Returns { success, points: {tl,tr,bl,br} in image px, reason }.
  function detectMarkers(imageData, layout) {
    const w = imageData.width, h = imageData.height;
    const threshold = otsuThreshold(imageData);
    const FontCore = getFontCore();
    const bitmap = FontCore.toBinaryBitmap(imageData, threshold);

    const expectedFrac = (layout.MARK_IN * layout.MARK_IN) / (layout.PAGE_IN.width * layout.PAGE_IN.height);
    const imgArea = w * h;
    const expectedArea = expectedFrac * imgArea;

    const components = connectedComponents(bitmap, w, h);
    const buckets = { 0: [], 1: [], 2: [], 3: [] };

    const sizeAspectOk = components.filter((comp) => {
      if (comp.minX === 0 || comp.minY === 0 || comp.maxX === w - 1 || comp.maxY === h - 1) return false;
      const aspect = comp.width / comp.height;
      if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) return false;
      if (comp.area < expectedArea * SIZE_FRAC_MIN || comp.area > expectedArea * SIZE_FRAC_MAX) return false;
      return true;
    });
    const hull = convexHull(sizeAspectOk.map((c) => c.centroid));
    const hullSet = new Set(hull);
    const onHull = sizeAspectOk.filter((c) => hullSet.has(c.centroid));

    for (const comp of onHull) {
      const holeCount = classifyHoleCount(bitmap, w, h, comp);
      if (holeCount === null || holeCount < 0 || holeCount > 3) continue;
      buckets[holeCount].push(comp);
    }

    for (const k of [0, 1, 2, 3]) {
      if (buckets[k].length !== 1) {
        return { success: false, reason: `Expected exactly 1 marker with ${k} hole(s), found ${buckets[k].length}.` };
      }
    }

    const keyByHoles = {};
    Object.entries(layout.MARK_HOLE_COUNTS).forEach(([key, holes]) => { keyByHoles[holes] = key; });

    const points = {};
    for (const k of [0, 1, 2, 3]) {
      points[keyByHoles[k]] = { x: buckets[k][0].centroid.x, y: buckets[k][0].centroid.y };
    }
    return { success: true, points, threshold };
  }

  const Markers = { otsuThreshold, connectedComponents, cropBitmap, classifyHoleCount, convexHull, detectMarkers };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Markers;
  } else {
    root.Markers = Markers;
  }
})(typeof window !== "undefined" ? window : globalThis);
