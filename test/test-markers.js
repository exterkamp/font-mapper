// Node-side tests for marker auto-detection: builds a synthetic "photo" of
// the page (plain pixel buffer, no canvas needed) using the real Layout
// geometry, and checks detectMarkers recovers the 4 corners - plus a
// negative case where identical markers should fail gracefully rather than
// mis-assign corners.
const assert = require("assert");
const Layout = require("../layout.js");
const Markers = require("../markers.js");

function makeSyntheticPhoto(pxPerIn, holeCountsOverride) {
  const w = Math.round(Layout.PAGE_IN.width * pxPerIn);
  const h = Math.round(Layout.PAGE_IN.height * pxPerIn);
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  function setPixel(x, y, v) {
    const i = (y * w + x) * 4;
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
  function fillRectIn(xIn, yIn, wIn, hIn, v) {
    const x0 = Math.round(xIn * pxPerIn), y0 = Math.round(yIn * pxPerIn);
    const x1 = Math.round((xIn + wIn) * pxPerIn), y1 = Math.round((yIn + hIn) * pxPerIn);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x >= 0 && y >= 0 && x < w && y < h) setPixel(x, y, v);
      }
    }
  }
  Layout.registrationMarks().forEach((m) => {
    const holes = holeCountsOverride ? holeCountsOverride[m.key] : m.holes;
    fillRectIn(m.x - Layout.MARK_IN / 2, m.y - Layout.MARK_IN / 2, Layout.MARK_IN, Layout.MARK_IN, 0);
    Layout.markHoleRectsIn(m.x, m.y, holes).forEach((hole) => fillRectIn(hole.x, hole.y, hole.w, hole.h, 255));
  });
  return { data, width: w, height: h };
}

function run() {
  const pxPerIn = 120;

  const goodPhoto = makeSyntheticPhoto(pxPerIn);
  const result = Markers.detectMarkers(goodPhoto, Layout);
  assert.ok(result.success, "expected successful marker detection: " + (result.reason || ""));
  Layout.registrationMarks().forEach((m) => {
    const expected = { x: m.x * pxPerIn, y: m.y * pxPerIn };
    const got = result.points[m.key];
    assert.ok(got, `missing detected point for ${m.key}`);
    assert.ok(Math.abs(got.x - expected.x) < 3, `${m.key} x off: expected ~${expected.x}, got ${got.x}`);
    assert.ok(Math.abs(got.y - expected.y) < 3, `${m.key} y off: expected ~${expected.y}, got ${got.y}`);
  });
  console.log("Marker auto-detection (happy path) passed:", JSON.stringify(result.points));

  // Degenerate case: all 4 markers identical (no holes) -> ambiguous, must fail-soft not guess.
  const ambiguousPhoto = makeSyntheticPhoto(pxPerIn, { tl: 0, tr: 0, bl: 0, br: 0 });
  const ambiguousResult = Markers.detectMarkers(ambiguousPhoto, Layout);
  assert.strictEqual(ambiguousResult.success, false, "identical markers should not produce a confident match");
  console.log("Marker auto-detection (ambiguous fallback) passed:", ambiguousResult.reason);

  // Sanity: a blank page (no markers at all) must also fail-soft, not throw.
  const blank = { data: new Uint8ClampedArray(Math.round(Layout.PAGE_IN.width * pxPerIn) * Math.round(Layout.PAGE_IN.height * pxPerIn) * 4).fill(255), width: Math.round(Layout.PAGE_IN.width * pxPerIn), height: Math.round(Layout.PAGE_IN.height * pxPerIn) };
  const blankResult = Markers.detectMarkers(blank, Layout);
  assert.strictEqual(blankResult.success, false, "blank page must not report success");
  console.log("Marker auto-detection (blank page) passed:", blankResult.reason);
}

run();
