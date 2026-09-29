// Verifies the auto-scanned per-glyph spacing feature end-to-end in the real
// app: a wide glyph ("O") should get a wider auto-scanned advance than a
// narrow one ("I"), a manual per-glyph override must show up in the
// downloaded font, and the "apply to all" global spacing nudge must shift
// every glyph's width together.
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
  await page.setViewport({ width: 1000, height: 2200 });
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push("console.error: " + msg.text()); });

  await page.goto(BASE_URL + "/index.html", { waitUntil: "load" });

  const photoInfo = await page.evaluate(() => {
    const size = Layout.canonicalPageSizePx();
    const canonical = document.createElement("canvas");
    canonical.width = size.w;
    canonical.height = size.h;
    const cctx = canonical.getContext("2d");
    cctx.fillStyle = "white";
    cctx.fillRect(0, 0, size.w, size.h);
    Layout.canonicalMarkPoints().forEach((m) => {
      const markPx = Layout.inToPx(Layout.MARK_IN);
      cctx.fillStyle = "black";
      cctx.fillRect(m.x - markPx / 2, m.y - markPx / 2, markPx, markPx);
      cctx.fillStyle = "white";
      Layout.markHoleRectsPx(m.x, m.y, m.holes).forEach((hole) => cctx.fillRect(hole.x, hole.y, hole.w, hole.h));
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

    // "I" is drawn as a narrow bar, "W" as a wide shape, so their auto-scanned
    // ink widths are unambiguously different.
    page0.forEach((ch, i) => {
      const rect = Layout.canonicalCellRectPx(i);
      cctx.fillStyle = "black";
      if (ch === "I") {
        cctx.fillRect(rect.x + rect.w * 0.45, rect.y + rect.h * 0.15, rect.w * 0.1, rect.h * 0.7);
      } else if (ch === "W") {
        cctx.fillRect(rect.x + rect.w * 0.05, rect.y + rect.h * 0.15, rect.w * 0.9, rect.h * 0.7);
      }
    });

    return { dataUrl: canonical.toDataURL("image/png"), width: canonical.width, height: canonical.height };
  });

  const tmpFile = path.join(os.tmpdir(), "fm-fake-scan-metrics.png");
  fs.writeFileSync(tmpFile, Buffer.from(photoInfo.dataUrl.split(",")[1], "base64"));

  // Page identity now comes from the QR baked into the photo, not the live
  // charset/ligature fields, so a single self-describing "chars" scan is enough.
  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(tmpFile);
  await page.waitForSelector("#align-stage:not([hidden])", { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById("align-hint").textContent.includes("Detecting"), { timeout: 10000 });

  const hint = await page.$eval("#align-hint", (el) => el.textContent);
  if (!hint.includes("Auto-detected all 4")) throw new Error("Expected auto-detect to succeed on an undistorted synthetic scan: " + hint);

  await page.click("#dewarp-btn");
  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });

  async function parseDownloadedFont() {
    const href = await page.$eval("#download-font", (el) => el.getAttribute("href"));
    return page.evaluate(async (h) => {
      const buf = await (await fetch(h)).arrayBuffer();
      const font = opentype.parse(buf);
      return {
        I: font.charToGlyph("I").advanceWidth,
        W: font.charToGlyph("W").advanceWidth,
        space: font.charToGlyph(" ").advanceWidth,
      };
    }, href);
  }

  const initial = await parseDownloadedFont();
  console.log("Initial auto-scanned widths:", JSON.stringify(initial));
  if (!(initial.W > initial.I)) {
    throw new Error(`Expected auto-scanned "W" to be wider than "I", got W=${initial.W} I=${initial.I}`);
  }

  // Metrics panel should have pre-populated visual cards, one per glyph plus space.
  const cardCount = await page.$eval("#metrics-panel", (el) => el.querySelectorAll(".metrics-card").length);
  const glyphCardCount = await page.evaluate(() => document.querySelectorAll("#metrics-panel .metrics-card[data-char]").length);
  console.log(`Metrics panel rendered ${cardCount} cards (${glyphCardCount} glyph cards + space).`);
  if (cardCount !== glyphCardCount + 1) throw new Error("Expected exactly one extra card for the space glyph");

  async function glyphBBoxX1(ch) {
    const href = await page.$eval("#download-font", (el) => el.getAttribute("href"));
    return page.evaluate(async (h, c) => {
      const buf = await (await fetch(h)).arrayBuffer();
      return opentype.parse(buf).charToGlyph(c).path.getBoundingBox().x1;
    }, href, ch);
  }

  // Real visual drag (the actual ask: adjust by dragging on the letter, not
  // typing numbers) - grab W's blue left-bearing line and drag it right.
  const pxPerUnit = await page.evaluate(() => window.__fmTestHooks.pxPerUnit());
  const beforeW = await page.evaluate(() => window.__fmTestHooks.getGlyphMetrics("W"));
  const bboxBeforeDrag = await glyphBBoxX1("W");
  const canvasBox = await page.$eval('#metrics-panel .metrics-card[data-char="W"] canvas', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, midY: r.top + r.height / 2 };
  });
  const startX = canvasBox.left + beforeW.leftBearing * pxPerUnit;
  const endX = canvasBox.left + (beforeW.leftBearing + 100) * pxPerUnit;
  await page.mouse.move(startX, canvasBox.midY);
  await page.mouse.down();
  await page.mouse.move(endX, canvasBox.midY, { steps: 5 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 50));

  const afterW = await page.evaluate(() => window.__fmTestHooks.getGlyphMetrics("W"));
  console.log("Dragged W's left-bearing handle:", beforeW.leftBearing, "->", afterW.leftBearing);
  const appliedDelta = afterW.leftBearing - beforeW.leftBearing;
  if (Math.abs(appliedDelta - 100) > 6) throw new Error(`Expected drag to move left-bearing by ~100, moved by ${appliedDelta}`);
  if (afterW.advanceWidth !== beforeW.advanceWidth) throw new Error("Dragging the left-bearing handle should not change advance width");

  const bboxAfterDrag = await glyphBBoxX1("W");
  const bboxShift = bboxAfterDrag - bboxBeforeDrag;
  if (Math.abs(bboxShift - appliedDelta) > 2) {
    throw new Error(`Expected the downloaded glyph outline to shift right by ${appliedDelta} units, actually shifted by ${bboxShift}`);
  }
  console.log(`Drag reached the downloaded font: glyph outline shifted right by ${bboxShift} units.`);

  // Manual per-glyph override (the programmatic equivalent of a drag) must reach the download.
  await page.evaluate(() => window.__fmTestHooks.setGlyphMetric("I", "advanceWidth", 777));
  await new Promise((r) => setTimeout(r, 50));
  const afterOverride = await parseDownloadedFont();
  if (afterOverride.I !== 777) throw new Error(`Manual override didn't reach the font: expected I=777, got ${afterOverride.I}`);
  console.log("Manual per-glyph width override reached the downloaded font: I =", afterOverride.I);

  // Global "apply to all" spacing nudge must shift every glyph (and space) together.
  await page.evaluate(() => { document.getElementById("global-spacing-delta").value = "40"; });
  await page.click("#apply-global-spacing");
  await new Promise((r) => setTimeout(r, 50));
  const afterGlobal = await parseDownloadedFont();
  console.log("After +40 global spacing:", JSON.stringify(afterGlobal));
  if (afterGlobal.I !== afterOverride.I + 40) throw new Error(`Expected I to shift by +40 from ${afterOverride.I}, got ${afterGlobal.I}`);
  if (afterGlobal.W !== initial.W + 40) throw new Error(`Expected W to shift by +40 from ${initial.W}, got ${afterGlobal.W}`);
  if (afterGlobal.space !== initial.space + 40) throw new Error(`Expected space to shift by +40, got ${afterGlobal.space}`);

  // Reset must restore the original auto-scanned values.
  await page.click("#reset-all-metrics");
  await new Promise((r) => setTimeout(r, 50));
  const afterReset = await parseDownloadedFont();
  if (afterReset.I !== initial.I || afterReset.W !== initial.W || afterReset.space !== initial.space) {
    throw new Error("Reset-all didn't restore original auto-scanned metrics: " + JSON.stringify(afterReset));
  }
  console.log("Reset-all correctly restored auto-scanned metrics.");

  if (consoleErrors.length) throw new Error("Console/page errors during run:\n" + consoleErrors.join("\n"));

  console.log("\nBrowser metrics E2E: ALL CHECKS PASSED");
  await browser.close();
}

main().catch((err) => {
  console.error("Browser metrics E2E FAILED:", err);
  process.exit(1);
});
