// Drives the real app in headless Chrome: synthesizes a "scanned" template
// with a known perspective distortion, uploads it, drags the alignment
// handles to the true corners, runs the threshold + build steps, and checks
// that a real, loadable font pops out the other end. Exercises DOM/canvas
// code paths the plain Node test in test-fontcore.js cannot reach.
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE_URL = process.env.FM_BASE_URL || "http://localhost:8090";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push("console.error: " + msg.text());
  });

  await page.goto(BASE_URL + "/index.html", { waitUntil: "load" });

  // Sanity check the template tab rendered something sane.
  const templateInfo = await page.evaluate(() => {
    const pages = document.querySelectorAll("#template-pages .page");
    const boxes = document.querySelectorAll(".cell-box");
    const marks = document.querySelectorAll(".reg-mark");
    return { pageCount: pages.length, boxCount: boxes.length, markCount: marks.length };
  });
  // Default template: 2 chars pages (QR now eats into per-page capacity) + 1 ligatures page.
  assertEq(templateInfo.pageCount, 3, "template page count");
  assertEq(templateInfo.markCount, 12, "registration mark count (4 per page)");
  console.log(`Template tab OK: ${templateInfo.pageCount} page(s), ${templateInfo.boxCount} cells, ${templateInfo.markCount} marks`);

  // Build a synthetic "photo" of the template with a known perspective warp,
  // ink filled into a handful of cells, entirely inside the page context
  // using the app's own Layout/Homography modules for geometric ground truth.
  const photoInfo = await page.evaluate(() => {
    const size = Layout.canonicalPageSizePx();
    const canonical = document.createElement("canvas");
    canonical.width = size.w;
    canonical.height = size.h;
    const cctx = canonical.getContext("2d");
    cctx.fillStyle = "white";
    cctx.fillRect(0, 0, size.w, size.h);

    const markPx = Layout.inToPx(Layout.MARK_IN);
    Layout.canonicalMarkPoints().forEach((m) => {
      cctx.fillStyle = "black";
      cctx.fillRect(m.x - markPx / 2, m.y - markPx / 2, markPx, markPx);
    });

    const page0 = Layout.buildPages(Layout.DEFAULT_CHARS)[0];

    // The app decodes each scan's own QR before it even reaches alignment,
    // so the synthetic photo needs a real one matching this page's tokens.
    const qrPayload = Layout.qrPayloadFor({ kind: "chars", tokens: page0 });
    const qr = qrcode(0, "M");
    qr.addData(qrPayload, "Byte");
    qr.make();
    const qrModules = qr.getModuleCount();
    const qrRect = Layout.qrRectIn();
    const qrX0 = Layout.inToPx(qrRect.x), qrY0 = Layout.inToPx(qrRect.y);
    const qrPxW = Layout.inToPx(qrRect.w) / qrModules, qrPxH = Layout.inToPx(qrRect.h) / qrModules;
    cctx.fillStyle = "black";
    for (let r = 0; r < qrModules; r++) {
      for (let c = 0; c < qrModules; c++) {
        if (qr.isDark(r, c)) cctx.fillRect(qrX0 + c * qrPxW, qrY0 + r * qrPxH, qrPxW + 0.6, qrPxH + 0.6);
      }
    }
    const inkChars = ["I", "O", "L"]; // solid, ring (hole), solid — covers both tracing branches
    const inked = [];
    page0.forEach((ch, i) => {
      if (!inkChars.includes(ch)) return;
      const rect = Layout.canonicalCellRectPx(i);
      cctx.fillStyle = "black";
      if (ch === "O") {
        const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
        cctx.beginPath();
        cctx.arc(cx, cy, rect.w * 0.35, 0, Math.PI * 2);
        cctx.arc(cx, cy, rect.w * 0.18, 0, Math.PI * 2, true);
        cctx.fill();
      } else {
        cctx.fillRect(rect.x + rect.w * 0.35, rect.y + rect.h * 0.15, rect.w * 0.3, rect.h * 0.7);
      }
      inked.push(ch);
    });

    // Known perspective distortion for the "photo": corners shifted from canonical.
    const canonicalMarks = Layout.canonicalMarkPoints();
    const shift = [
      { dx: 15, dy: 10 }, { dx: -20, dy: 25 }, { dx: 25, dy: -15 }, { dx: -10, dy: -20 },
    ];
    const photoMarks = canonicalMarks.map((m, i) => ({ x: m.x + shift[i].dx, y: m.y + shift[i].dy }));

    const photo = document.createElement("canvas");
    photo.width = size.w;
    photo.height = size.h;
    const pctx = photo.getContext("2d");
    const H = Homography.solveHomography(photoMarks, canonicalMarks); // photo -> canonical, for sampling
    const srcImg = cctx.getImageData(0, 0, size.w, size.h);
    const dstImg = pctx.createImageData(size.w, size.h);
    const sd = srcImg.data, dd = dstImg.data;
    const sw = size.w, sh = size.h;
    // Bilinear, not nearest-neighbor - matches what a real camera lens would
    // produce and avoids aliasing sharp enough to break the QR's fine modules.
    for (let y = 0; y < photo.height; y++) {
      for (let x = 0; x < photo.width; x++) {
        const p = Homography.applyHomography(H, x, y);
        const di = (y * photo.width + x) * 4;
        if (p.x < 0 || p.y < 0 || p.x > sw - 1 || p.y > sh - 1) {
          dd[di] = dd[di + 1] = dd[di + 2] = 255; dd[di + 3] = 255; continue;
        }
        const x0b = Math.floor(p.x), y0b = Math.floor(p.y);
        const x1b = Math.min(x0b + 1, sw - 1), y1b = Math.min(y0b + 1, sh - 1);
        const fx = p.x - x0b, fy = p.y - y0b;
        for (let c = 0; c < 3; c++) {
          const v00 = sd[(y0b * sw + x0b) * 4 + c], v10 = sd[(y0b * sw + x1b) * 4 + c];
          const v01 = sd[(y1b * sw + x0b) * 4 + c], v11 = sd[(y1b * sw + x1b) * 4 + c];
          const v0 = v00 + (v10 - v00) * fx, v1 = v01 + (v11 - v01) * fx;
          dd[di + c] = v0 + (v1 - v0) * fy;
        }
        dd[di + 3] = 255;
      }
    }
    pctx.putImageData(dstImg, 0, 0);

    return {
      dataUrl: photo.toDataURL("image/png"),
      width: photo.width,
      height: photo.height,
      photoMarks,
      inked,
    };
  });

  console.log(`Synthetic scan generated: ${photoInfo.width}x${photoInfo.height}, inked chars: ${photoInfo.inked.join(",")}`);

  const tmpFile = path.join(os.tmpdir(), "fm-fake-scan.png");
  const base64 = photoInfo.dataUrl.split(",")[1];
  fs.writeFileSync(tmpFile, Buffer.from(base64, "base64"));

  // Switch to the build tab and upload the fake scan. Page identity now
  // comes from the QR baked into the photo, not from the live charset/
  // ligature fields, so a single self-describing "chars" scan is enough.
  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(tmpFile);
  await page.waitForSelector("#align-stage:not([hidden])", { timeout: 5000 });
  // This photo's markers are plain uniform squares (no hole-count identity),
  // so auto-detect should recognize the ambiguity and fall back to manual defaults.
  await page.waitForFunction(() => !document.getElementById("align-hint").textContent.includes("Detecting"), { timeout: 5000 });
  const autoDetectHint = await page.$eval("#align-hint", (el) => el.textContent);
  if (!autoDetectHint.includes("Couldn't auto-detect")) {
    throw new Error("Expected uniform-square markers to fail auto-detect and fall back to manual: " + autoDetectHint);
  }
  console.log("Auto-detect correctly fell back to manual for ambiguous uniform markers.");

  const canvasDims = await page.evaluate(() => {
    const el = document.getElementById("align-canvas");
    return { width: el.width, height: el.height };
  });
  const workScale = canvasDims.width / photoInfo.width;
  assertClose(canvasDims.height / photoInfo.height, workScale, 0.001, "x/y scale should match (uniform downscale)");
  console.log(`App downscaled the ${photoInfo.width}x${photoInfo.height} photo to ${canvasDims.width}x${canvasDims.height} (scale ${workScale.toFixed(4)}) for alignment.`);

  // Give the canvas plenty of viewport room, but the canvas is also CSS-scaled
  // (max-width: 100%) to fit its container, so mouse coordinates must go
  // through the CSS-size-to-buffer-size ratio, same as app.js's own handlers do.
  await page.setViewport({ width: Math.ceil(canvasDims.width) + 100, height: Math.ceil(canvasDims.height) + 200 });
  const canvasBox = await page.$eval("#align-canvas", (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const cssScaleX = canvasBox.width / canvasDims.width;
  const cssScaleY = canvasBox.height / canvasDims.height;
  const toScreen = (bufX, bufY) => ({
    x: canvasBox.left + bufX * cssScaleX,
    y: canvasBox.top + bufY * cssScaleY,
  });

  for (let i = 0; i < 4; i++) {
    const defaultPos = await page.evaluate((idx) => {
      return window.__fmTestHooks.getHandle(idx);
    }, i);
    const target = { x: photoInfo.photoMarks[i].x * workScale, y: photoInfo.photoMarks[i].y * workScale };
    const from = toScreen(defaultPos.x, defaultPos.y);
    const to = toScreen(target.x, target.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
  }

  const handlesAfterDrag = await page.evaluate(() => window.__fmTestHooks.getAllHandles());
  photoInfo.photoMarks.forEach((rawTarget, i) => {
    const target = { x: rawTarget.x * workScale, y: rawTarget.y * workScale };
    assertClose(handlesAfterDrag[i].x, target.x, 3, `handle ${i} x after drag`);
    assertClose(handlesAfterDrag[i].y, target.y, 3, `handle ${i} y after drag`);
  });
  console.log("Alignment handles dragged onto true corners OK.");

  await page.click("#dewarp-btn");
  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  console.log("Dewarp + threshold stage reached OK.");

  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });
  const statusText = await page.$eval("#build-status", (el) => el.textContent);
  console.log("Build status:", statusText);

  const fontHref = await page.$eval("#download-font", (el) => el.getAttribute("href"));
  if (!fontHref || !fontHref.startsWith("blob:")) throw new Error("Expected a blob: URL for the font download link");

  // Pull the actual font bytes out of the page and parse them with opentype.js
  // (loaded in-page) to confirm the traced I/O/L glyphs really made it in with ink.
  const fontCheck = await page.evaluate(async (href) => {
    const buf = await (await fetch(href)).arrayBuffer();
    const font = opentype.parse(buf);
    const results = {};
    ["I", "O", "L"].forEach((ch) => {
      const g = font.charToGlyph(ch);
      results[ch] = { hasGlyph: !!g, commandCount: g ? g.path.commands.length : 0 };
    });
    const untouched = font.charToGlyph("Z"); // never inked -> should not exist as a real glyph
    return { results, byteLength: buf.byteLength, untouchedIsNotdef: untouched && untouched.index === 0 };
  }, fontHref);

  console.log("Parsed downloaded font:", JSON.stringify(fontCheck));
  ["I", "O", "L"].forEach((ch) => {
    if (!fontCheck.results[ch].hasGlyph || fontCheck.results[ch].commandCount === 0) {
      throw new Error(`Expected traced glyph with a real outline for "${ch}", got ${JSON.stringify(fontCheck.results[ch])}`);
    }
  });
  if (!fontCheck.untouchedIsNotdef) throw new Error('Expected untouched "Z" cell to fall back to .notdef (glyph index 0)');
  if (fontCheck.byteLength < 200) throw new Error("Font buffer suspiciously small");

  if (consoleErrors.length) {
    throw new Error("Console/page errors during run:\n" + consoleErrors.join("\n"));
  }

  console.log("\nBrowser E2E: ALL CHECKS PASSED");
  await browser.close();
}

function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
function assertClose(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ~${expected} (±${tol}), got ${actual}`);
}

main().catch((err) => {
  console.error("Browser E2E FAILED:", err);
  process.exit(1);
});
