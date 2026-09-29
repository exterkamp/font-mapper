// Verifies the per-letter "move the crop" fix: draws ink for "M" that
// extends above the box's top edge (like a tall ascender or a loop that
// runs past the printed guide), so the default crop clips it - then clicks
// the real "nudge crop up" button in the metrics panel and confirms the
// re-traced glyph actually recovers more of the shape. Also checks that
// nudging into blank space reverts cleanly instead of corrupting state.
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE_URL = process.env.FM_BASE_URL || "http://localhost:8111";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";

function bboxHeight(contours) {
  let minY = Infinity, maxY = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return maxY - minY;
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

    // Ink for "M" deliberately starts above the box's top edge, so the
    // default crop (which only samples inside the box) clips its top off.
    const rect = Layout.canonicalCellRectPx(0);
    cctx.fillStyle = "black";
    const inkTop = rect.y - 15;
    const inkBottom = rect.y + 50;
    cctx.fillRect(rect.x + rect.w * 0.3, inkTop, rect.w * 0.4, inkBottom - inkTop);

    return canvas.toDataURL("image/png");
  });

  const file = path.join(os.tmpdir(), "fm-crop-nudge.png");
  fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(file);
  await page.waitForSelector("#align-stage:not([hidden])", { timeout: 5000 });
  await page.waitForFunction(() => !document.getElementById("align-hint").textContent.includes("Detecting"), { timeout: 10000 });
  const hint = await page.$eval("#align-hint", (el) => el.textContent);
  if (!hint.includes("Auto-detected all 4")) throw new Error("Expected auto-detect to succeed: " + hint);
  await page.click("#dewarp-btn");
  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });

  const before = await page.evaluate(() => window.__fmTestHooks.getGlyphMetrics("M"));
  const beforeHeight = bboxHeight(before.contours);
  console.log("Ink bbox height before nudge (grid units):", beforeHeight);

  // Click the real "nudge crop up" button several times - re-querying each
  // time since every click re-renders the whole metrics panel.
  const upSelector = '#metrics-panel .metrics-card[data-char="M"] .crop-nudge-btn[title="Nudge crop up"]';
  for (let i = 0; i < 10; i++) {
    await page.click(upSelector);
    await new Promise((r) => setTimeout(r, 30));
  }

  const statusAfterNudge = await page.$eval("#build-status", (el) => el.textContent);
  console.log("Status after nudging up:", statusAfterNudge);
  if (!statusAfterNudge.includes("Adjusted the crop")) {
    throw new Error(`Expected an "Adjusted the crop" status message, got: ${statusAfterNudge}`);
  }

  const after = await page.evaluate(() => window.__fmTestHooks.getGlyphMetrics("M"));
  const afterHeight = bboxHeight(after.contours);
  console.log("Ink bbox height after nudging up (grid units):", afterHeight);
  if (!(afterHeight > beforeHeight * 1.15)) {
    throw new Error(`Expected nudging up to recover more of the clipped shape (height should grow meaningfully): before=${beforeHeight}, after=${afterHeight}`);
  }
  console.log("PASS: nudging the crop up recovered the previously-clipped top of the letter.\n");

  // Nudging way too far should land on blank space and revert cleanly, not corrupt state.
  const downSelector = '#metrics-panel .metrics-card[data-char="M"] .crop-nudge-btn[title="Nudge crop down"]';
  for (let i = 0; i < 60; i++) {
    await page.click(downSelector);
    await new Promise((r) => setTimeout(r, 20));
  }
  const statusAfterOvershoot = await page.$eval("#build-status", (el) => el.textContent);
  console.log("Status after overshooting down:", statusAfterOvershoot);
  if (!statusAfterOvershoot.toLowerCase().includes("blank") || !statusAfterOvershoot.toLowerCase().includes("reverted")) {
    throw new Error(`Expected a graceful revert-on-blank message, got: ${statusAfterOvershoot}`);
  }
  const stillThere = await page.evaluate(() => window.__fmTestHooks.getGlyphMetrics("M"));
  if (!stillThere || !stillThere.contours || !stillThere.contours.length) {
    throw new Error("After an overshoot revert, M's metrics entry should still be intact (non-empty contours)");
  }
  console.log("PASS: overshooting into blank space reverted cleanly, leaving a valid glyph in place.\n");

  if (consoleErrors.length) throw new Error("Console/page errors during run:\n" + consoleErrors.join("\n"));

  console.log("Browser crop-nudge E2E: ALL CHECKS PASSED");
  await browser.close();
}

main().catch((err) => {
  console.error("Browser crop-nudge E2E FAILED:", err);
  process.exit(1);
});
