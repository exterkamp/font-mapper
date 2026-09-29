// Node-side smoke tests for the shared logic modules. Exercises the same
// code paths the browser app uses (contour tracing, font assembly,
// homography, layout math) without needing a browser or a real scan.
const assert = require("assert");
const otLib = require("opentype.js");
const FontCore = require("../fontcore.js");
const Homography = require("../homography.js");
const Layout = require("../layout.js");

function makeGrid(size, fillFn) {
  const bitmap = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bitmap[y * size + x] = fillFn(x, y) ? 1 : 0;
    }
  }
  return bitmap;
}

function run() {
  const size = 40;

  // "O"-like shape: filled square ring with a hole in the middle.
  const ringBitmap = makeGrid(size, (x, y) => {
    const inOuter = x >= 5 && x < 35 && y >= 5 && y < 35;
    const inHole = x >= 14 && x < 26 && y >= 14 && y < 26;
    return inOuter && !inHole;
  });
  const ringContours = FontCore.traceContours(ringBitmap, size, size);
  assert.strictEqual(ringContours.length, 2, "ring shape should trace to exactly 2 contours (outer + hole)");

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }
  const areas = ringContours.map(signedArea);
  assert.ok(areas[0] * areas[1] < 0, "outer contour and hole must have opposite winding (nonzero fill rule)");

  // "I"-like shape: solid filled square, no holes.
  const solidBitmap = makeGrid(size, (x, y) => x >= 8 && x < 32 && y >= 4 && y < 36);
  const solidContours = FontCore.traceContours(solidBitmap, size, size);
  assert.strictEqual(solidContours.length, 1, "solid shape should trace to exactly 1 contour");

  const simplifiedRing = FontCore.simplifyContours(ringContours, 0.6);
  const simplifiedSolid = FontCore.simplifyContours(solidContours, 0.6);
  assert.ok(simplifiedRing[0].length <= ringContours[0].length, "RDP should not add points");
  simplifiedRing.forEach((c) => assert.ok(c.length >= 3, "simplified contour must stay a valid polygon"));

  // Auto-scanned metrics: a wide "O" and a narrow "I" should get different
  // advance widths sized to their own ink, not a shared fixed box.
  const ringMetrics = FontCore.naturalMetrics(simplifiedRing, size);
  const solidMetrics = FontCore.naturalMetrics(simplifiedSolid, size);
  assert.ok(ringMetrics.advanceWidth > solidMetrics.advanceWidth, "wider ink should auto-scan to a wider advance than narrower ink");
  assert.strictEqual(ringMetrics.leftBearing, FontCore.DEFAULT_SIDE_BEARING);

  const glyphDefs = [
    { name: "O", unicode: "O".codePointAt(0), contours: simplifiedRing, gridWidth: size, gridHeight: size, leftBearing: ringMetrics.leftBearing, advanceWidth: ringMetrics.advanceWidth },
    { name: "I", unicode: "I".codePointAt(0), contours: simplifiedSolid, gridWidth: size, gridHeight: size, leftBearing: solidMetrics.leftBearing, advanceWidth: solidMetrics.advanceWidth },
  ];
  const font = FontCore.buildFont(otLib, glyphDefs, { familyName: "TestHand", styleName: "Regular" });
  const buf = font.toArrayBuffer();
  assert.ok(buf.byteLength > 0, "font should serialize to a non-empty buffer");

  const reparsed = otLib.parse(buf);
  assert.strictEqual(reparsed.getEnglishName("fontFamily"), "TestHand");
  const glyphO = reparsed.charToGlyph("O");
  const glyphI = reparsed.charToGlyph("I");
  assert.ok(glyphO.path.commands.length > 0, "O glyph must have a non-empty path");
  assert.ok(glyphI.path.commands.length > 0, "I glyph must have a non-empty path");
  assert.strictEqual(glyphO.advanceWidth, ringMetrics.advanceWidth);
  assert.strictEqual(glyphI.advanceWidth, solidMetrics.advanceWidth);
  assert.ok(glyphO.advanceWidth > glyphI.advanceWidth, "downloaded font should preserve the per-glyph auto-scanned widths");

  // A manual override (the "adjust width/kerning" knob) must take effect verbatim.
  const overriddenDefs = [
    { name: "I", unicode: "I".codePointAt(0), contours: simplifiedSolid, gridWidth: size, gridHeight: size, leftBearing: 10, advanceWidth: 250 },
  ];
  const overriddenFont = FontCore.buildFont(otLib, overriddenDefs, { familyName: "Overridden" });
  const overriddenGlyph = otLib.parse(overriddenFont.toArrayBuffer()).charToGlyph("I");
  assert.strictEqual(overriddenGlyph.advanceWidth, 250, "manual advance-width override must be respected");

  const glyphSpace = reparsed.charToGlyph(" ");
  assert.strictEqual(glyphSpace.advanceWidth, FontCore.SPACE_ADVANCE);
  assert.strictEqual(glyphSpace.path.commands.length, 0, "space glyph must be empty");

  // Ligatures: a wide non-square grid (like a "th" cell) must scale
  // proportionally wider in font units, and GSUB "liga" wiring must survive
  // a full serialize/reparse round trip under both DFLT and latn scripts.
  const ligGridW = 100, ligGridH = 64;
  const ligBitmap = new Uint8Array(ligGridW * ligGridH);
  for (let y = 10; y < 54; y++) for (let x = 10; x < 90; x++) ligBitmap[y * ligGridW + x] = 1;
  const ligContours = FontCore.simplifyContours(FontCore.traceContours(ligBitmap, ligGridW, ligGridH), 0.6);
  const ligUnitsPerEmWidth = Math.round(FontCore.UNITS_PER_EM * (ligGridW / ligGridH));
  const ligMetrics = FontCore.naturalMetrics(ligContours, ligGridW, ligUnitsPerEmWidth);
  assert.ok(ligUnitsPerEmWidth > FontCore.UNITS_PER_EM, "a wider grid must map to more font units, not get squashed into a normal em box");

  const tDef = { name: "t", unicode: "t".codePointAt(0), contours: simplifiedSolid, gridWidth: size, gridHeight: size, leftBearing: solidMetrics.leftBearing, advanceWidth: solidMetrics.advanceWidth };
  const hDef = { name: "h", unicode: "h".codePointAt(0), contours: simplifiedRing, gridWidth: size, gridHeight: size, leftBearing: ringMetrics.leftBearing, advanceWidth: ringMetrics.advanceWidth };
  const thDef = { name: "th_liga", unicode: undefined, contours: ligContours, gridWidth: ligGridW, gridHeight: ligGridH, unitsPerEmWidth: ligUnitsPerEmWidth, leftBearing: ligMetrics.leftBearing, advanceWidth: ligMetrics.advanceWidth };
  const ligFont = FontCore.buildFont(otLib, [tDef, hDef, thDef], { familyName: "LigaTest" });
  // glyph order: .notdef=0, space=1, t=2, h=3, th_liga=4
  FontCore.addLigatureSubstitution(ligFont, [2, 3], 4);

  const reparsedLiga = otLib.parse(ligFont.toArrayBuffer());
  const ligaDFLT = reparsedLiga.substitution.getLigatures("liga", "DFLT", "dflt");
  const ligaLatn = reparsedLiga.substitution.getLigatures("liga", "latn", "dflt");
  assert.deepStrictEqual(ligaDFLT, [{ sub: [2, 3], by: 4 }], "GSUB liga substitution must round-trip under DFLT script");
  assert.deepStrictEqual(ligaLatn, [{ sub: [2, 3], by: 4 }], "GSUB liga substitution must round-trip under latn script");
  assert.strictEqual(reparsedLiga.glyphs.get(4).unicode, undefined, "ligature glyph must have no cmap entry of its own");
  assert.ok(reparsedLiga.glyphs.get(4).path.commands.length > 0, "ligature glyph must have a real traced outline");

  // Homography: recover a known projective warp.
  const src = [
    { x: 12, y: 30 },
    { x: 410, y: 5 },
    { x: 0, y: 500 },
    { x: 460, y: 480 },
  ];
  const dst = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 0, y: 400 },
    { x: 300, y: 400 },
  ];
  const H = Homography.solveHomography(dst, src); // dst -> src, as used to sample the source image
  dst.forEach((d, i) => {
    const mapped = Homography.applyHomography(H, d.x, d.y);
    assert.ok(Math.abs(mapped.x - src[i].x) < 1e-6, "homography should map corner exactly (x)");
    assert.ok(Math.abs(mapped.y - src[i].y) < 1e-6, "homography should map corner exactly (y)");
  });
  const center = Homography.applyHomography(H, 150, 200);
  assert.ok(center.x > 0 && center.x < 460 && center.y > 0 && center.y < 500, "interior point maps inside source quad");

  // Layout: grid + pagination should be internally consistent.
  const { cols, rows } = Layout.computeGrid();
  assert.ok(cols > 0 && rows > 0, "grid must have positive dimensions");
  const pages = Layout.buildPages(Layout.DEFAULT_CHARS);
  const totalOnPages = pages.reduce((sum, p) => sum + p.length, 0);
  assert.strictEqual(totalOnPages, Layout.DEFAULT_CHARS.length, "pagination must not drop or duplicate characters");
  const marks = Layout.canonicalMarkPoints();
  assert.strictEqual(marks.length, 4);
  const pageSize = Layout.canonicalPageSizePx();
  marks.forEach((m) => {
    assert.ok(m.x >= 0 && m.x <= pageSize.w && m.y >= 0 && m.y <= pageSize.h, "registration marks must be within the page");
  });
  const rect0 = Layout.canonicalCellRectPx(0);
  assert.ok(rect0.w > 0 && rect0.h > 0);

  console.log("All fontcore/homography/layout tests passed.");
  console.log(`  grid: ${cols}x${rows} = ${cols * rows} cells/page, ${pages.length} page(s) for ${Layout.DEFAULT_CHARS.length} default chars`);
}

run();
