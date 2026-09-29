// Closes a real gap in the other tests: they all verify the *downloaded
// font file* updates correctly after a metrics/crop edit, by fetching and
// parsing it with opentype.js - none of them ever checked that the live
// on-screen "Preview" text actually re-renders. This test measures the
// preview element's rendered glyph shape (via canvas measureText's
// actualBoundingBox*, using whatever font-family #font-preview is currently
// set to) before and after a crop nudge, and confirms it visibly changes.
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE_URL = process.env.FM_BASE_URL || "http://localhost:8111";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";

async function measurePreviewGlyphHeight(page, ch) {
  return page.evaluate((c) => {
    const preview = document.getElementById("font-preview");
    const family = getComputedStyle(preview).fontFamily;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = `48px ${family}`;
    const m = ctx.measureText(c);
    return {
      family,
      height: (m.actualBoundingBoxAscent || 0) + (m.actualBoundingBoxDescent || 0),
    };
  }, ch);
}

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

  // Same clipped-ink "M" setup as the crop-nudge test: ink starts above the
  // box's top edge, so the default crop clips it and nudging up recovers more.
  const dataUrl = await page.evaluate(() => {
    const pageDescriptor = { kind: "chars", tokens: ["M"] };
    const size = Layout.canonicalPageSizePx();
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const cctx = canvas.getContext("2d");
    cctx.fillStyle = "white";
    cctx.fillRect(0, 0, size.w, size.h);
    Layout.canonicalMarkPoints().forEach((m) => {
      const markPx = Layout.inToPx(Layout.MARK_IN);
      cctx.fillStyle = "black";
      cctx.fillRect(m.x - markPx / 2, m.y - markPx / 2, markPx, markPx);
      cctx.fillStyle = "white";
      Layout.markHoleRectsPx(m.x, m.y, m.holes).forEach((h) => cctx.fillRect(h.x, h.y, h.w, h.h));
    });
    const qrPayload = Layout.qrPayloadFor(pageDescriptor);
    const qr = qrcode(0, "M");
    qr.addData(qrPayload, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    const qrRect = Layout.qrRectIn();
    const qx0 = Layout.inToPx(qrRect.x), qy0 = Layout.inToPx(qrRect.y);
    const qpw = Layout.inToPx(qrRect.w) / n, qph = Layout.inToPx(qrRect.h) / n;
    cctx.fillStyle = "black";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) cctx.fillRect(qx0 + c * qpw, qy0 + r * qph, qpw + 0.6, qph + 0.6);
      }
    }
    const rect = Layout.canonicalCellRectPx(0);
    cctx.fillStyle = "black";
    const inkTop = rect.y - 15;
    const inkBottom = rect.y + 50;
    cctx.fillRect(rect.x + rect.w * 0.3, inkTop, rect.w * 0.4, inkBottom - inkTop);
    return canvas.toDataURL("image/png");
  });

  const file = path.join(os.tmpdir(), "fm-preview-refresh.png");
  fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(file);
  await page.waitForSelector("#align-stage:not([hidden])", { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById("align-hint").textContent.includes("Detecting"), { timeout: 10000 });
  await page.click("#dewarp-btn");
  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });

  // Make sure the preview text actually contains "M" and wait for the font to attach.
  await page.evaluate(() => {
    const ta = document.getElementById("preview-text");
    ta.value = "M";
    ta.dispatchEvent(new Event("input"));
  });
  await page.waitForFunction(() => document.fonts.status === "loaded" || true);
  await new Promise((r) => setTimeout(r, 150));

  const before = await measurePreviewGlyphHeight(page, "M");
  console.log("Preview family before nudge:", before.family, "glyph height:", before.height);

  const upSelector = '#metrics-panel .metrics-card[data-char="M"] .crop-nudge-btn[title="Nudge crop up"]';
  for (let i = 0; i < 10; i++) {
    await page.click(upSelector);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 200)); // let the async FontFace.load() settle

  const after = await measurePreviewGlyphHeight(page, "M");
  console.log("Preview family after nudge:", after.family, "glyph height:", after.height);

  if (after.family === before.family) {
    throw new Error(`Expected the preview's font-family to change to a fresh internal name after rebuilding, got the same family both times: ${before.family}`);
  }
  if (!(after.height > before.height * 1.1)) {
    throw new Error(`Expected the live preview's rendered "M" to visibly grow taller after nudging up (recovering clipped ink), got before=${before.height} after=${after.height}`);
  }
  console.log("PASS: the live preview's rendered glyph actually updated after the crop nudge, not just the downloaded font file.\n");

  if (consoleErrors.length) throw new Error("Console/page errors during run:\n" + consoleErrors.join("\n"));

  console.log("Browser preview-refresh E2E: ALL CHECKS PASSED");
  await browser.close();
}

main().catch((err) => {
  console.error("Browser preview-refresh E2E FAILED:", err);
  process.exit(1);
});
