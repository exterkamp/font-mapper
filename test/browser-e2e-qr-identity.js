// Verifies the actual point of the per-page QR code: scans are self-describing,
// so (1) upload order doesn't matter, (2) duplicate/unreadable pages are
// caught with a clear error instead of silently producing a wrong font, and
// (3) a scan still decodes correctly even if the live charset/ligature
// fields have since been edited - the app reads what's printed, not current
// UI state.
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const BASE_URL = process.env.FM_BASE_URL || "http://localhost:8111";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 2200 });
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push("console.error: " + msg.text()); });
  await page.goto(BASE_URL + "/index.html", { waitUntil: "load" });
  return { page, consoleErrors };
}

// Builds a small, self-contained "chars" or "ligature" page photo: correct
// corner markers, a real QR encoding exactly `tokens`, and a solid block of
// ink in each requested cell. Runs entirely in-page (Layout/qrcode globals).
async function makePagePhoto(page, kind, tokens, inkTokens) {
  return page.evaluate((kind, tokens, inkTokens) => {
    const pageDescriptor = { kind, tokens };
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
    const x0 = Layout.inToPx(qrRect.x), y0 = Layout.inToPx(qrRect.y);
    const pw = Layout.inToPx(qrRect.w) / n, ph = Layout.inToPx(qrRect.h) / n;
    cctx.fillStyle = "black";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) cctx.fillRect(x0 + c * pw, y0 + r * ph, pw + 0.6, ph + 0.6);
      }
    }

    const cellRectFn = kind === "ligature" ? Layout.canonicalLigatureCellRectPx : Layout.canonicalCellRectPx;
    tokens.forEach((token, i) => {
      if (!inkTokens.includes(token)) return;
      const rect = cellRectFn(i);
      cctx.fillStyle = "black";
      cctx.fillRect(rect.x + rect.w * 0.2, rect.y + rect.h * 0.2, rect.w * 0.6, rect.h * 0.6);
    });
    return canvas.toDataURL("image/png");
  }, kind, tokens, inkTokens);
}

async function saveDataUrl(dataUrl, name) {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
  return file;
}

async function runAlignAndDewarpAll(page, count) {
  for (let i = 0; i < count; i++) {
    await page.waitForSelector("#align-stage:not([hidden])", { timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById("align-hint").textContent.includes("Detecting"), { timeout: 10000 });
    const hint = await page.$eval("#align-hint", (el) => el.textContent);
    if (!hint.includes("Auto-detected all 4")) throw new Error(`Scan ${i}: expected auto-detect to succeed, got: ${hint}`);
    await page.click("#dewarp-btn");
  }
}

async function testOrderIndependence(browser) {
  const { page } = await newPage(browser);
  const charsPhoto = await makePagePhoto(page, "chars", ["A", "B", "C"], ["A"]);
  const ligaPhoto = await makePagePhoto(page, "ligature", ["th"], ["th"]);
  const charsFile = await saveDataUrl(charsPhoto, "fm-qrid-chars.png");
  const ligaFile = await saveDataUrl(ligaPhoto, "fm-qrid-liga.png");

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  // Uploaded in REVERSED order (ligature page first) - the app must not assume position order.
  await fileInput.uploadFile(ligaFile, charsFile);
  await runAlignAndDewarpAll(page, 2);
  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });

  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#metrics-panel .metrics-card[data-char]")).map((c) => c.dataset.char)
  );
  console.log("Order-independence test: cards =", JSON.stringify(cards));
  if (!cards.includes("A") || !cards.includes("th")) {
    throw new Error(`Expected "A" and "th" regardless of upload order, got ${JSON.stringify(cards)}`);
  }
  console.log("PASS: reversed upload order still resolved to the correct pages.\n");
  await page.close();
}

async function testDuplicateDetection(browser) {
  const { page } = await newPage(browser);
  const charsPhoto = await makePagePhoto(page, "chars", ["A", "B"], ["A"]);
  const charsFile = await saveDataUrl(charsPhoto, "fm-qrid-dup.png");

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(charsFile, charsFile); // same page, twice
  await new Promise((r) => setTimeout(r, 500));
  const status = await page.$eval("#build-status", (el) => el.textContent);
  console.log("Duplicate-detection test: status =", JSON.stringify(status));
  if (!status.includes("same page")) throw new Error(`Expected a duplicate-page error, got: ${status}`);
  const alignVisible = await page.$eval("#align-stage", (el) => !el.hidden);
  if (alignVisible) throw new Error("Should not have proceeded to alignment after detecting a duplicate page");
  console.log("PASS: duplicate page upload was caught with a clear error.\n");
  await page.close();
}

async function testUnreadableQr(browser) {
  const { page } = await newPage(browser);
  // A photo with valid corner markers but no QR drawn at all.
  const blankQrPhoto = await page.evaluate(() => {
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
    return canvas.toDataURL("image/png");
  });
  const file = await saveDataUrl(blankQrPhoto, "fm-qrid-blank.png");

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(file);
  await new Promise((r) => setTimeout(r, 500));
  const status = await page.$eval("#build-status", (el) => el.textContent);
  console.log("Unreadable-QR test: status =", JSON.stringify(status));
  if (!status.includes("Couldn't read the page-identity QR code")) {
    throw new Error(`Expected a clear unreadable-QR error, got: ${status}`);
  }
  console.log("PASS: a page with no readable QR was rejected with a clear error, not silently guessed.\n");
  await page.close();
}

async function testDecoupledFromLiveUi(browser) {
  const { page } = await newPage(browser);
  // Encode a page with tokens the CURRENT template textareas know nothing about.
  const photo = await makePagePhoto(page, "chars", ["Q", "R"], ["Q"]);
  const file = await saveDataUrl(photo, "fm-qrid-stale.png");

  // Simulate "the user edited the template after printing this page":
  // completely replace the live charset/ligature fields with something else.
  await page.evaluate(() => {
    const charsEl = document.getElementById("charset-input");
    const ligEl = document.getElementById("ligature-input");
    charsEl.value = "ZZZ999";
    ligEl.value = "zz";
    charsEl.dispatchEvent(new Event("input"));
    ligEl.dispatchEvent(new Event("input"));
  });

  await page.click('.tab-btn[data-tab="build"]');
  const fileInput = await page.$("#scan-input");
  await fileInput.uploadFile(file);
  await runAlignAndDewarpAll(page, 1);
  await page.waitForSelector("#threshold-stage:not([hidden])", { timeout: 5000 });
  await page.click("#build-font-btn");
  await page.waitForSelector("#result-stage:not([hidden])", { timeout: 5000 });

  const cards = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#metrics-panel .metrics-card[data-char]")).map((c) => c.dataset.char)
  );
  console.log("Decoupled-from-live-UI test: cards =", JSON.stringify(cards));
  if (!cards.includes("Q") || cards.includes("Z")) {
    throw new Error(`Expected the scan's own encoded tokens (Q) to win over the since-edited live fields (Z...), got ${JSON.stringify(cards)}`);
  }
  console.log("PASS: scan was interpreted using its own printed content, not the current (since-edited) UI state.\n");
  await page.close();
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  await testOrderIndependence(browser);
  await testDuplicateDetection(browser);
  await testUnreadableQr(browser);
  await testDecoupledFromLiveUi(browser);
  await browser.close();
  console.log("Browser QR-identity E2E: ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("Browser QR-identity E2E FAILED:", err);
  process.exit(1);
});
