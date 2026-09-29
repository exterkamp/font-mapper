// Drives the real app in headless Chrome with a synthetic "photo" that uses
// the actual hole-coded corner markers (not just plain squares), under a
// known perspective distortion, and checks that auto-detection alone - with
// zero simulated dragging - lands the handles on the true corners and lets
// the rest of the pipeline (dewarp/threshold/build) complete.
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE_URL = process.env.FM_BASE_URL || "http://localhost:8111";
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

  const photoInfo = await page.evaluate(() => {
    const size = Layout.canonicalPageSizePx();
    const canonical = document.createElement("canvas");
    canonical.width = size.w;
    canonical.height = size.h;
    const cctx = canonical.getContext("2d");
    cctx.fillStyle = "white";
    cctx.fillRect(0, 0, size.w, size.h);

    // Real hole-coded markers, exactly like the printed template.
    Layout.canonicalMarkPoints().forEach((m) => {
      const markPx = Layout.inToPx(Layout.MARK_IN);
      cctx.fillStyle = "black";
      cctx.fillRect(m.x - markPx / 2, m.y - markPx / 2, markPx, markPx);
      cctx.fillStyle = "white";
      Layout.markHoleRectsPx(m.x, m.y, m.holes).forEach((hole) => {
        cctx.fillRect(hole.x, hole.y, hole.w, hole.h);
      });
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

    const inkChars = ["I", "O", "L"];
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

    const canonicalMarks = Layout.canonicalMarkPoints();
    const shift = [
      { dx: 18, dy: 12 }, { dx: -22, dy: 20 }, { dx: 20, dy: -18 }, { dx: -14, dy: -22 },
    ];
    const photoMarks = canonicalMarks.map((m, i) => ({ x: m.x + shift[i].dx, y: m.y + shift[i].dy }));

    const photo = document.createElement("canvas");
    photo.width = size.w;
    photo.height = size.h;
    const pctx = photo.getContext("2d");
    const H = Homography.solveHomography(photoMarks, canonicalMarks);
    const srcImg = cctx.getImageData(0, 0, size.w, size.h);
    const dstImg = pctx.createImageData(size.w, size.h);
    const sd = srcImg.data, dd = dstImg.data;
    const sw = size.w, sh = size.h;
    // Bilinear, not nearest-neighbor - a real camera lens softens edges too,
    // and nearest-neighbor's harsher aliasing was enough to break the QR's
    // fine modules even though a real photo at this distortion decodes fine.
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

    return { dataUrl: photo.toDataURL("image/png"), width: photo.width, height: photo.height, photoMarks, inked };
  });

  console.log(`Synthetic hole-coded scan generated: ${photoInfo.width}x${photoInfo.height}, inked: ${photoInfo.inked.join(",")}`);

  const tmpFile = path.join(os.tmpdir(), "fm-fake-scan-autodetect.png");
  fs.writeFileSync(tmpFile, Buffer.from(photoInfo.dataUrl.split(",")[1], "base64"));

  // Page identity now comes from the QR baked into the photo, not the live
  // charset/ligature fields, so a single self-describing "chars" scan is enough.

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(tmpFile);
  await page.waitForSelector("#align-stage:not([hidden])", { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById("align-hint").textContent.includes("Detecting"), { timeout: 10000 });

  const hint = await page.$eval("#align-hint", (el) => el.textContent);
  console.log("Align hint:", hint);
  if (!hint.includes("Auto-detected all 4")) {
    throw new Error("Expected auto-detection to succeed with hole-coded markers, got: " + hint);
  }

  // No dragging at all - check the handles the app picked on its own.
  const canvasDims = await page.evaluate(() => {
    const el = document.getElementById("align-canvas");
    return { width: el.width, height: el.height };
  });
  const workScale = canvasDims.width / photoInfo.width;
  const handles = await page.evaluate(() => window.__fmTestHooks.getAllHandles());
  photoInfo.photoMarks.forEach((rawTarget, i) => {
    const target = { x: rawTarget.x * workScale, y: rawTarget.y * workScale };
    assertClose(handles[i].x, target.x, 4, `auto-detected handle ${i} x`);
    assertClose(handles[i].y, target.y, 4, `auto-detected handle ${i} y`);
  });
  console.log("Auto-detected handles matched the true corners with zero dragging.");

  await page.click("#dewarp-btn");
  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });

  const fontHref = await page.$eval("#download-font", (el) => el.getAttribute("href"));
  const fontCheck = await page.evaluate(async (href) => {
    const buf = await (await fetch(href)).arrayBuffer();
    const font = opentype.parse(buf);
    const results = {};
    ["I", "O", "L"].forEach((ch) => {
      const g = font.charToGlyph(ch);
      results[ch] = { hasGlyph: !!g, commandCount: g ? g.path.commands.length : 0 };
    });
    return results;
  }, fontHref);
  console.log("Parsed downloaded font:", JSON.stringify(fontCheck));
  ["I", "O", "L"].forEach((ch) => {
    if (!fontCheck[ch].hasGlyph || fontCheck[ch].commandCount === 0) {
      throw new Error(`Expected traced glyph with a real outline for "${ch}", got ${JSON.stringify(fontCheck[ch])}`);
    }
  });

  if (consoleErrors.length) throw new Error("Console/page errors during run:\n" + consoleErrors.join("\n"));

  console.log("\nBrowser auto-detect E2E: ALL CHECKS PASSED");
  await browser.close();
}

function assertClose(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ~${expected} (±${tol}), got ${actual}`);
}

main().catch((err) => {
  console.error("Browser auto-detect E2E FAILED:", err);
  process.exit(1);
});
