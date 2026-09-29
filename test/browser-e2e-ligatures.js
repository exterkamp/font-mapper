// Drives the full two-page flow (letters page + ligatures page) in headless
// Chrome: synthesizes both scans, uploads them together (exercising the
// scan-input's `multiple` attribute), builds the font, and proves the "th"
// ligature actually substitutes during real browser text layout - not just
// that a GSUB table with the right bytes exists.
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

  const templateInfo = await page.evaluate(() => {
    const pages = Layout.buildTemplatePages(Layout.DEFAULT_CHARS, Layout.DEFAULT_LIGATURES);
    return { kinds: pages.map((p) => p.kind), ligaturePage: pages.find((p) => p.kind === "ligature").tokens };
  });
  console.log("Default template pages:", JSON.stringify(templateInfo.kinds));
  if (!templateInfo.ligaturePage.includes("th")) throw new Error('Expected "th" in the default ligature set');

  // Build an undistorted "photo" of a given page kind: white background,
  // correct hole-coded markers, and ink only in the requested cells. Each
  // callback is self-contained (only uses in-page globals Layout/Homography)
  // so it can cross the puppeteer serialization boundary as-is.
  const charsDataUrl = await page.evaluate(() => {
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
    const pageDescriptor = Layout.buildTemplatePages(Layout.DEFAULT_CHARS, Layout.DEFAULT_LIGATURES).find((p) => p.kind === "chars");

    // The app decodes each scan's own QR before it even reaches alignment.
    const qrPayload = Layout.qrPayloadFor(pageDescriptor);
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

    pageDescriptor.tokens.forEach((token, i) => {
      if (token !== "t" && token !== "h") return;
      const rect = Layout.canonicalCellRectPx(i);
      cctx.fillStyle = "black";
      // Narrow bars so their combined width is unambiguously less than the
      // deliberately-wide ligature glyph drawn below.
      cctx.fillRect(rect.x + rect.w * 0.4, rect.y + rect.h * 0.15, rect.w * 0.15, rect.h * 0.7);
    });
    return canvas.toDataURL("image/png");
  });

  const ligaturesDataUrl = await page.evaluate(() => {
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
    const pageDescriptor = Layout.buildTemplatePages(Layout.DEFAULT_CHARS, Layout.DEFAULT_LIGATURES).find((p) => p.kind === "ligature");

    const qrPayload = Layout.qrPayloadFor(pageDescriptor);
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

    pageDescriptor.tokens.forEach((token, i) => {
      if (token !== "th") return;
      const rect = Layout.canonicalLigatureCellRectPx(i);
      cctx.fillStyle = "black";
      cctx.fillRect(rect.x + rect.w * 0.05, rect.y + rect.h * 0.15, rect.w * 0.9, rect.h * 0.7);
    });
    return canvas.toDataURL("image/png");
  });

  const charsFile = path.join(os.tmpdir(), "fm-ligatures-chars.png");
  const ligaturesFile = path.join(os.tmpdir(), "fm-ligatures-liga.png");
  fs.writeFileSync(charsFile, Buffer.from(charsDataUrl.split(",")[1], "base64"));
  fs.writeFileSync(ligaturesFile, Buffer.from(ligaturesDataUrl.split(",")[1], "base64"));

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  const isMultiple = await page.$eval("#scan-input", (el) => el.multiple);
  if (!isMultiple) throw new Error("#scan-input must have the multiple attribute for multi-page templates to be usable");
  await fileInput.uploadFile(charsFile, ligaturesFile);

  // Walk through both pages' align -> dewarp steps.
  for (let pageIdx = 0; pageIdx < 2; pageIdx++) {
    await page.waitForSelector("#align-stage:not([hidden])", { timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById("align-hint").textContent.includes("Detecting"), { timeout: 10000 });
    const hint = await page.$eval("#align-hint", (el) => el.textContent);
    if (!hint.includes("Auto-detected all 4")) throw new Error(`Page ${pageIdx}: expected auto-detect to succeed, got: ${hint}`);
    await page.click("#dewarp-btn");
  }

  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  console.log("Both pages aligned and dewarped OK.");

  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });

  const cardChars = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#metrics-panel .metrics-card[data-char]")).map((c) => c.dataset.char)
  );
  console.log("Metrics panel glyphs:", JSON.stringify(cardChars));
  if (!cardChars.includes("t") || !cardChars.includes("h") || !cardChars.includes("th")) {
    throw new Error(`Expected t, h, and th cards; got ${JSON.stringify(cardChars)}`);
  }

  const familyName = await page.$eval("#font-name-input", (el) => el.value);
  const href = await page.$eval("#download-font", (el) => el.getAttribute("href"));
  const fontFacts = await page.evaluate(async (h) => {
    const buf = await (await fetch(h)).arrayBuffer();
    const font = opentype.parse(buf);
    return {
      liga: font.substitution.getLigatures("liga", "DFLT", "dflt"),
      ligaLatn: font.substitution.getLigatures("liga", "latn", "dflt"),
      tAdvance: font.charToGlyph("t").advanceWidth,
      hAdvance: font.charToGlyph("h").advanceWidth,
      thGlyphAdvance: font.glyphs.get(font.substitution.getLigatures("liga", "DFLT", "dflt")[0].by).advanceWidth,
    };
  }, href);
  console.log("Font GSUB facts:", JSON.stringify(fontFacts));
  if (fontFacts.liga.length !== 1) throw new Error("Expected exactly one DFLT liga substitution");
  if (fontFacts.ligaLatn.length !== 1) throw new Error("Expected exactly one latn liga substitution");
  if (!(fontFacts.thGlyphAdvance > fontFacts.tAdvance + fontFacts.hAdvance)) {
    throw new Error("Test setup issue: ligature glyph should be deliberately wider than t+h combined");
  }

  // The real proof: does the browser's own text layout actually substitute
  // "th" for the ligature glyph, not just "does the GSUB table exist".
  const widths = await page.evaluate(async (family) => {
    await document.fonts.ready;
    function measure(text) {
      const span = document.createElement("span");
      span.style.cssText = `position:absolute; visibility:hidden; white-space:nowrap; font-size:500px; font-family:"${family}";`;
      span.textContent = text;
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width;
      span.remove();
      return w;
    }
    return { t: measure("t"), h: measure("h"), th: measure("th") };
  }, familyName);
  console.log("Rendered widths at 500px:", JSON.stringify(widths));

  const sumSeparate = widths.t + widths.h;
  if (Math.abs(widths.th - sumSeparate) < 5) {
    throw new Error(`"th" rendered as separate t+h (${widths.th} ~= ${sumSeparate}) - ligature substitution did not fire`);
  }
  if (widths.th <= sumSeparate) {
    throw new Error(`Expected the ligature-substituted "th" (${widths.th}) to render wider than separate t+h (${sumSeparate})`);
  }
  console.log(`Ligature substitution confirmed: "th" rendered at ${widths.th}px vs ${sumSeparate}px for separate t+h.`);

  if (consoleErrors.length) throw new Error("Console/page errors during run:\n" + consoleErrors.join("\n"));

  console.log("\nBrowser ligatures E2E: ALL CHECKS PASSED");
  await browser.close();
}

main().catch((err) => {
  console.error("Browser ligatures E2E FAILED:", err);
  process.exit(1);
});
