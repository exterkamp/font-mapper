(function () {
  "use strict";

  const MAX_WORK_DIM = 1600;
  const GLYPH_GRID = 64; // sampling height for every cell; width varies (wider for ligatures)
  const LIGATURE_WIDTH_RATIO = Layout.LIGATURE_CELL_IN.width / Layout.CELL_IN.size;
  const LIGATURE_GRID_WIDTH = Math.round(GLYPH_GRID * LIGATURE_WIDTH_RATIO);
  // Margin against the printed border being picked up as ink. In a clean
  // synthetic render the guide border color (#aaaaaa) is safely above any
  // reasonable threshold, but a real photographed scan blurs and shadows
  // that edge enough to drag it under the threshold - and a too-tight
  // margin compounds worse on the wider ligature boxes, where the same
  // dewarp imprecision lands further from the box center. 0.08 is the
  // proven-safe value; the taller box already nets more usable room even
  // with this margin restored.
  const CELL_INSET = 0.08;

  function isLigatureToken(token) {
    return token.length > 1;
  }

  const AGL_NAMES = {
    ".": "period", ",": "comma", "!": "exclam", "?": "question",
    "'": "quotesingle", '"': "quotedbl", "-": "hyphen", ":": "colon",
    ";": "semicolon", "(": "parenleft", ")": "parenright",
  };
  function glyphNameFor(token) {
    if (isLigatureToken(token)) return token.replace(/[^A-Za-z0-9]/g, "") + "_liga";
    if (AGL_NAMES[token]) return AGL_NAMES[token];
    if (/^[A-Za-z0-9]$/.test(token)) return token;
    return "uni" + token.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  }

  function paintBitmapBlackOnWhite(ctx, bitmap, width, height) {
    const out = ctx.createImageData(width, height);
    for (let i = 0; i < bitmap.length; i++) {
      const v = bitmap[i] ? 0 : 255;
      out.data[i * 4] = v;
      out.data[i * 4 + 1] = v;
      out.data[i * 4 + 2] = v;
      out.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
  }

  // ---------------- Tabs ----------------
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  // ---------------- Template rendering ----------------
  const charsetInput = document.getElementById("charset-input");
  const ligatureInput = document.getElementById("ligature-input");
  charsetInput.value = Layout.DEFAULT_CHARS.join("");
  ligatureInput.value = Layout.DEFAULT_LIGATURES.join(" ");

  function currentCharset() {
    const raw = charsetInput.value;
    const seen = new Set();
    const out = [];
    for (const ch of raw) {
      if (ch === "\n" || ch === "\r") continue;
      if (seen.has(ch)) continue;
      seen.add(ch);
      out.push(ch);
    }
    return out;
  }

  function currentLigatures() {
    const seen = new Set();
    const out = [];
    ligatureInput.value.split(/\s+/).forEach((token) => {
      if (token.length < 2 || seen.has(token)) return;
      seen.add(token);
      out.push(token);
    });
    return out;
  }

  // Drawn as SVG (not a CSS background) because Chrome/Firefox/Safari all
  // have a "print background graphics" toggle that's off by default, which
  // silently strips CSS `background` fills (but not borders, text, or actual
  // image/SVG content) from the printed page.
  const SVG_NS = "http://www.w3.org/2000/svg";
  function buildMarkerSVG(m, markIn) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.classList.add("reg-mark");
    svg.style.left = m.x + "in";
    svg.style.top = m.y + "in";
    svg.style.width = markIn + "in";
    svg.style.height = markIn + "in";

    const body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("x", "0");
    body.setAttribute("y", "0");
    body.setAttribute("width", "100");
    body.setAttribute("height", "100");
    body.setAttribute("fill", "black");
    svg.appendChild(body);

    const originX = m.x - markIn / 2;
    const originY = m.y - markIn / 2;
    Layout.markHoleRectsIn(m.x, m.y, m.holes).forEach((hole) => {
      const holeEl = document.createElementNS(SVG_NS, "rect");
      holeEl.setAttribute("x", (((hole.x - originX) / markIn) * 100).toString());
      holeEl.setAttribute("y", (((hole.y - originY) / markIn) * 100).toString());
      holeEl.setAttribute("width", ((hole.w / markIn) * 100).toString());
      holeEl.setAttribute("height", ((hole.h / markIn) * 100).toString());
      holeEl.setAttribute("fill", "white");
      svg.appendChild(holeEl);
    });
    return svg;
  }

  // Encodes the page's kind + exact ordered token list as a QR code, drawn
  // the same SVG-modules way as the corner markers so it always prints.
  // This is what makes each scan self-describing: the app reads what's
  // actually on the page instead of trusting upload order or current UI state.
  function buildQrSVG(pageDescriptor, rectIn) {
    const payload = Layout.qrPayloadFor(pageDescriptor);
    const qr = qrcode(0, "M");
    qr.addData(payload, "Byte");
    qr.make();
    const n = qr.getModuleCount();

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
    svg.classList.add("qr-code");
    svg.style.left = rectIn.x + "in";
    svg.style.top = rectIn.y + "in";
    svg.style.width = rectIn.w + "in";
    svg.style.height = rectIn.h + "in";

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        const rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", c.toString());
        rect.setAttribute("y", r.toString());
        rect.setAttribute("width", "1");
        rect.setAttribute("height", "1");
        rect.setAttribute("fill", "black");
        svg.appendChild(rect);
      }
    }
    return svg;
  }

  function renderTemplate() {
    const pages = Layout.buildTemplatePages(currentCharset(), currentLigatures());
    const container = document.getElementById("template-pages");
    container.innerHTML = "";
    const page = Layout.PAGE_IN;
    const markIn = Layout.MARK_IN;

    pages.forEach((pageDescriptor) => {
      const isLig = pageDescriptor.kind === "ligature";
      const cellRectIn = isLig ? Layout.ligatureCellRectIn : Layout.cellRectIn;
      const labelRectIn = isLig ? Layout.ligatureLabelRectIn : Layout.labelRectIn;
      const baselineTicksIn = isLig ? Layout.ligatureBaselineTicksIn : Layout.baselineTicksIn;

      const pageEl = document.createElement("div");
      pageEl.className = "page";
      pageEl.style.width = page.width + "in";
      pageEl.style.height = page.height + "in";

      Layout.registrationMarks().forEach((m) => {
        pageEl.appendChild(buildMarkerSVG(m, markIn));
      });
      pageEl.appendChild(buildQrSVG(pageDescriptor, Layout.qrRectIn()));

      pageDescriptor.tokens.forEach((token, i) => {
        const rect = cellRectIn(i);
        const box = document.createElement("div");
        box.className = "cell-box";
        box.style.left = rect.x + "in";
        box.style.top = rect.y + "in";
        box.style.width = rect.w + "in";
        box.style.height = rect.h + "in";
        pageEl.appendChild(box);

        const labelRect = labelRectIn(i);
        const label = document.createElement("div");
        label.className = "cell-label";
        label.style.left = labelRect.x + "in";
        label.style.top = labelRect.y + "in";
        label.style.width = labelRect.w + "in";
        label.style.height = labelRect.h + "in";
        label.textContent = token === " " ? "␣" : token;
        pageEl.appendChild(label);

        baselineTicksIn(i).forEach((tick) => {
          const tickEl = document.createElement("div");
          tickEl.className = "baseline-tick";
          tickEl.style.left = tick.x1 + "in";
          tickEl.style.top = tick.y1 + "in";
          tickEl.style.width = (tick.x2 - tick.x1) + "in";
          pageEl.appendChild(tickEl);
        });
      });

      const wrap = document.createElement("div");
      wrap.className = "page-scale-wrap";
      wrap.appendChild(pageEl);
      container.appendChild(wrap);
    });

    fitPagesToViewport();
  }

  // .page is always sized at true physical inches so print comes out
  // correctly, which is much wider than a phone screen; scale it down
  // visually to fit here, purely cosmetic (print media resets this).
  function fitPagesToViewport() {
    const container = document.getElementById("template-pages");
    const naturalWidthPx = Layout.PAGE_IN.width * 96;
    const naturalHeightPx = Layout.PAGE_IN.height * 96;
    const available = container.clientWidth || window.innerWidth;
    const scale = Math.min(1, available / naturalWidthPx);
    container.querySelectorAll(".page-scale-wrap").forEach((wrap) => {
      const pageEl = wrap.querySelector(".page");
      pageEl.style.transform = `scale(${scale})`;
      wrap.style.width = naturalWidthPx * scale + "px";
      wrap.style.height = naturalHeightPx * scale + "px";
    });
  }

  document.getElementById("reset-charset").addEventListener("click", () => {
    charsetInput.value = Layout.DEFAULT_CHARS.join("");
    ligatureInput.value = Layout.DEFAULT_LIGATURES.join(" ");
    renderTemplate();
  });
  charsetInput.addEventListener("input", renderTemplate);
  ligatureInput.addEventListener("input", renderTemplate);
  document.getElementById("print-template").addEventListener("click", () => window.print());
  window.addEventListener("resize", fitPagesToViewport);
  renderTemplate();

  // ---------------- Scan & Build state ----------------
  const state = {
    charset: [],
    pages: [], // { kind, tokens }[], one per uploaded scan, decoded from each scan's own QR code
    pageIndex: 0,
    handles: null, // 4 {x,y} in working-canvas pixel space, order tl,tr,bl,br
    workImage: null, // current HTMLImageElement being aligned
    dewarpedByPage: [], // one canvas per page, aligned with state.pages index
    rawCellData: new Map(), // token (char or ligature string) -> cropped ImageData, wider grid for ligatures
    tokenSource: new Map(), // token -> { flat, cropX, cropY, cropW, cropH, gridW, gridH } - the base crop, before any per-token nudge
    cropOffsets: new Map(), // token -> { dx, dy } in canonical px, for the per-letter "move the crop" fix
    lastGlyphDefs: null,
    lastFamilyName: "MyHandwriting",
  };

  const scanInput = document.getElementById("scan-input");
  const alignStage = document.getElementById("align-stage");
  const thresholdStage = document.getElementById("threshold-stage");
  const resultStage = document.getElementById("result-stage");
  const statusEl = document.getElementById("build-status");
  const canvas = document.getElementById("align-canvas");
  const ctx = canvas.getContext("2d");

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  // Full resolution (well beyond MAX_WORK_DIM) so a dense QR still has
  // enough pixels per module to decode reliably - this runs on the
  // original photo, independent of the smaller alignment working copy.
  const QR_DECODE_MAX_DIM = 2600;

  async function decodePageQr(file) {
    const img = await loadImageFromFile(file);
    const scale = Math.min(1, QR_DECODE_MAX_DIM / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    const imageData = c.getContext("2d").getImageData(0, 0, w, h);
    const result = jsQR(imageData.data, w, h);
    if (!result) return null;
    return Layout.parseQrPayload(result.data);
  }

  scanInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    alignStage.hidden = true;
    thresholdStage.hidden = true;
    resultStage.hidden = true;
    setStatus(`Reading the page-identity code on ${files.length} scan(s)…`);

    // Each scan decodes its own kind + exact token list, so pages are
    // matched to their content regardless of the order they were uploaded
    // in, and keep working even if the live charset/ligature fields have
    // since changed.
    const decoded = [];
    for (const file of files) {
      const result = await decodePageQr(file);
      if (!result || !result.tokens.length) {
        setStatus(`Couldn't read the page-identity QR code on "${file.name}". Try a flatter, sharper, better-lit photo, or re-print that page.`);
        return;
      }
      decoded.push(result);
    }
    for (let i = 0; i < decoded.length; i++) {
      for (let j = i + 1; j < decoded.length; j++) {
        if (decoded[i].kind === decoded[j].kind && decoded[i].tokens.join(" ") === decoded[j].tokens.join(" ")) {
          setStatus(`"${files[i].name}" and "${files[j].name}" decoded to the same page — did you upload one page twice and miss another?`);
          return;
        }
      }
    }

    state.pages = decoded.map((d) => ({ kind: d.kind, tokens: d.tokens }));
    state.charset = decoded.reduce((all, d) => all.concat(d.tokens), []);
    state.pageIndex = 0;
    state.dewarpedByPage = new Array(state.pages.length).fill(null);
    state.uploadedFiles = files;
    setStatus("");
    await loadPageImage(0);
  });

  const alignHint = document.getElementById("align-hint");

  async function loadPageImage(pageIdx) {
    const file = state.uploadedFiles[pageIdx];
    if (!file) {
      setStatus("Internal error: no scan for this page index.");
      return;
    }
    const img = await loadImageFromFile(file);
    state.workImage = img;

    const scale = Math.min(1, MAX_WORK_DIM / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    setDefaultHandles();
    alignStage.hidden = false;
    document.querySelector("#align-stage h2").textContent =
      `Step 2 — Confirm alignment (page ${pageIdx + 1} of ${state.pages.length})`;
    drawAlignCanvas();
    alignHint.textContent = "Detecting the 4 corner markers automatically…";
    setTimeout(runAutoDetect, 0); // let the "detecting…" hint paint before the CPU-bound pass
  }

  function setDefaultHandles() {
    const inset = 0.1;
    state.handles = [
      { x: canvas.width * inset, y: canvas.height * inset },
      { x: canvas.width * (1 - inset), y: canvas.height * inset },
      { x: canvas.width * inset, y: canvas.height * (1 - inset) },
      { x: canvas.width * (1 - inset), y: canvas.height * (1 - inset) },
    ];
  }

  function runAutoDetect() {
    ctx.drawImage(state.workImage, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = Markers.detectMarkers(imageData, Layout);
    if (result.success) {
      state.handles = [result.points.tl, result.points.tr, result.points.bl, result.points.br];
      alignHint.textContent = "Auto-detected all 4 corner markers. Drag a handle if any look off, then continue.";
    } else {
      setDefaultHandles();
      alignHint.textContent = `Couldn't auto-detect the markers (${result.reason}) — drag each numbered handle onto its matching corner square (1=top-left, 2=top-right, 3=bottom-left, 4=bottom-right).`;
    }
    drawAlignCanvas();
  }
  document.getElementById("redetect-btn").addEventListener("click", runAutoDetect);

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function drawAlignCanvas() {
    ctx.drawImage(state.workImage, 0, 0, canvas.width, canvas.height);
    const labels = ["1", "2", "3", "4"];
    state.handles.forEach((h, i) => {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(47,111,235,0.35)";
      ctx.fill();
      ctx.strokeStyle = "#2f6feb";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labels[i], h.x, h.y);
    });
  }

  let activeHandle = -1;
  function handleAt(x, y) {
    for (let i = 0; i < state.handles.length; i++) {
      const h = state.handles[i];
      if (Math.hypot(h.x - x, h.y - y) <= 20) return i;
    }
    return -1;
  }
  // The canvas is displayed scaled down (CSS max-width) from its internal
  // working resolution, so pointer coordinates need converting back to
  // buffer pixels via the CSS-size-to-attribute-size ratio.
  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }
  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = canvasPointFromEvent(e);
    activeHandle = handleAt(x, y);
    if (activeHandle >= 0) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (activeHandle < 0) return;
    const { x: rawX, y: rawY } = canvasPointFromEvent(e);
    const x = Math.max(0, Math.min(canvas.width, rawX));
    const y = Math.max(0, Math.min(canvas.height, rawY));
    state.handles[activeHandle] = { x, y };
    drawAlignCanvas();
  });
  canvas.addEventListener("pointerup", () => { activeHandle = -1; });
  canvas.addEventListener("pointercancel", () => { activeHandle = -1; });

  document.getElementById("dewarp-btn").addEventListener("click", () => {
    setStatus("Straightening…");
    const flat = dewarpCurrentPage();
    state.dewarpedByPage[state.pageIndex] = flat;
    const next = state.pageIndex + 1;
    if (next < state.pages.length) {
      state.pageIndex = next;
      loadPageImage(next);
      setStatus("");
    } else {
      alignStage.hidden = true;
      setStatus("");
      enterThresholdStage();
    }
  });

  function dewarpCurrentPage() {
    const dst = Layout.canonicalMarkPoints(); // tl,tr,bl,br in VDPI px
    const src = state.handles; // same order
    const H = Homography.solveHomography(dst, src); // dst -> src, for sampling
    const size = Layout.canonicalPageSizePx();
    const out = document.createElement("canvas");
    out.width = size.w;
    out.height = size.h;
    const outCtx = out.getContext("2d");
    const outImg = outCtx.createImageData(size.w, size.h);

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = canvas.width;
    srcCanvas.height = canvas.height;
    srcCanvas.getContext("2d").drawImage(state.workImage, 0, 0, canvas.width, canvas.height);
    const srcImg = srcCanvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);

    bilinearWarp(srcImg, outImg, H);
    outCtx.putImageData(outImg, 0, 0);
    return out;
  }

  function bilinearWarp(srcImg, dstImg, H) {
    const sw = srcImg.width, sh = srcImg.height;
    const dw = dstImg.width, dh = dstImg.height;
    const sd = srcImg.data, dd = dstImg.data;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const p = Homography.applyHomography(H, x, y);
        const di = (y * dw + x) * 4;
        if (p.x < 0 || p.y < 0 || p.x > sw - 1 || p.y > sh - 1) {
          dd[di] = dd[di + 1] = dd[di + 2] = 255;
          dd[di + 3] = 255;
          continue;
        }
        const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
        const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = p.x - x0, fy = p.y - y0;
        for (let c = 0; c < 3; c++) {
          const v00 = sd[(y0 * sw + x0) * 4 + c];
          const v10 = sd[(y0 * sw + x1) * 4 + c];
          const v01 = sd[(y1 * sw + x0) * 4 + c];
          const v11 = sd[(y1 * sw + x1) * 4 + c];
          const v0 = v00 + (v10 - v00) * fx;
          const v1 = v01 + (v11 - v01) * fx;
          dd[di + c] = v0 + (v1 - v0) * fy;
        }
        dd[di + 3] = 255;
      }
    }
  }

  // ---------------- Threshold + preview stage ----------------
  const previewsEl = document.getElementById("cell-previews");
  const thresholdSlider = document.getElementById("threshold-slider");
  const thresholdValue = document.getElementById("threshold-value");

  // Re-crops a single token from its stored source rect plus any manual
  // nudge offset, and updates state.rawCellData in place. This is what both
  // the initial threshold-stage crop and the later per-letter "move the
  // crop" fix run through, so a nudge is just "redo this with an offset."
  function recropToken(token) {
    const src = state.tokenSource.get(token);
    if (!src) return null;
    const offset = state.cropOffsets.get(token) || { dx: 0, dy: 0 };
    const small = document.createElement("canvas");
    small.width = src.gridW;
    small.height = src.gridH;
    const sctx = small.getContext("2d");
    sctx.drawImage(src.flat, src.cropX + offset.dx, src.cropY + offset.dy, src.cropW, src.cropH, 0, 0, src.gridW, src.gridH);
    const imageData = sctx.getImageData(0, 0, src.gridW, src.gridH);
    state.rawCellData.set(token, imageData);
    return imageData;
  }

  function enterThresholdStage() {
    state.rawCellData.clear();
    state.tokenSource.clear();
    state.cropOffsets.clear();
    state.pages.forEach((pageDescriptor, pageIdx) => {
      const isLig = pageDescriptor.kind === "ligature";
      const canonicalCellRectPx = isLig ? Layout.canonicalLigatureCellRectPx : Layout.canonicalCellRectPx;
      const gridW = isLig ? LIGATURE_GRID_WIDTH : GLYPH_GRID;
      const gridH = GLYPH_GRID;
      const flat = state.dewarpedByPage[pageIdx];

      pageDescriptor.tokens.forEach((token, i) => {
        const rect = canonicalCellRectPx(i);
        const insetX = rect.w * CELL_INSET;
        const insetY = rect.h * CELL_INSET;
        state.tokenSource.set(token, {
          flat,
          cropX: rect.x + insetX,
          cropY: rect.y + insetY,
          cropW: rect.w - 2 * insetX,
          cropH: rect.h - 2 * insetY,
          gridW,
          gridH,
        });
        recropToken(token);
      });
    });

    previewsEl.innerHTML = "";
    state.charset.forEach((token) => {
      const raw = state.rawCellData.get(token);
      if (!raw) return;
      const wrap = document.createElement("div");
      const label = document.createElement("div");
      label.textContent = token === " " ? "␣" : token;
      label.style.fontSize = "10px";
      label.style.textAlign = "center";
      const prevCanvas = document.createElement("canvas");
      prevCanvas.width = raw.width;
      prevCanvas.height = raw.height;
      prevCanvas.dataset.token = token;
      wrap.appendChild(prevCanvas);
      wrap.appendChild(label);
      previewsEl.appendChild(wrap);
    });

    thresholdStage.hidden = false;
    redrawThresholdPreviews();
  }

  function redrawThresholdPreviews() {
    const threshold = Number(thresholdSlider.value);
    thresholdValue.textContent = String(threshold);
    previewsEl.querySelectorAll("canvas").forEach((cnv) => {
      const raw = state.rawCellData.get(cnv.dataset.token);
      if (!raw) return;
      const bitmap = FontCore.toBinaryBitmap(raw, threshold);
      paintBitmapBlackOnWhite(cnv.getContext("2d"), bitmap, raw.width, raw.height);
    });
  }
  thresholdSlider.addEventListener("input", redrawThresholdPreviews);

  // ---------------- Font build ----------------
  // state.glyphMetrics: char -> { contours, gridSize, leftBearing, advanceWidth,
  // naturalLeftBearing, naturalAdvanceWidth, inkMinX, inkCanvas }. Tracing
  // happens once (on "Build font"); every metrics edit after that just
  // re-serializes from this map, no re-tracing needed, so dragging feels instant.
  const CARD_HEIGHT_PX = 90;
  const PX_PER_UNIT = CARD_HEIGHT_PX / (FontCore.BOX_TOP - FontCore.BOX_BOTTOM);
  const HANDLE_HIT_PX = 14;
  const CROP_NUDGE_STEP_PX = Layout.inToPx(0.02); // small, fine-grained step for the per-letter crop fix
  let previewGeneration = 0; // bumped on every rebuild; guards the live preview against out-of-order async font loads

  document.getElementById("build-font-btn").addEventListener("click", () => buildAndShowFont());
  document.getElementById("rebuild-font-btn").addEventListener("click", () => rebuildFontAndPreview());
  document.getElementById("apply-global-spacing").addEventListener("click", applyGlobalSpacing);
  document.getElementById("reset-all-metrics").addEventListener("click", resetAllMetrics);

  // Traces one token's current raw crop into a glyphMetrics entry (contours,
  // natural spacing, ink preview canvas). Shared by the initial full build
  // and by the per-letter "move the crop" fix, which only needs to redo
  // this one token rather than re-tracing everything.
  function traceTokenIntoMetrics(token, threshold) {
    const raw = state.rawCellData.get(token);
    if (!raw) return false;
    const gridW = raw.width;
    const gridH = raw.height;
    const unitsPerEmWidth = Math.round(FontCore.UNITS_PER_EM * (gridW / gridH));
    const bitmap = FontCore.toBinaryBitmap(raw, threshold);
    const contours = FontCore.traceContours(bitmap, gridW, gridH);
    if (!contours.length) return false;
    const simplified = FontCore.simplifyContours(contours, 0.6);
    const natural = FontCore.naturalMetrics(simplified, gridW, unitsPerEmWidth);

    const inkCanvas = document.createElement("canvas");
    inkCanvas.width = gridW;
    inkCanvas.height = gridH;
    paintBitmapBlackOnWhite(inkCanvas.getContext("2d"), bitmap, gridW, gridH);

    state.glyphMetrics.set(token, {
      contours: simplified,
      gridWidth: gridW,
      gridHeight: gridH,
      unitsPerEmWidth,
      leftBearing: natural.leftBearing,
      advanceWidth: natural.advanceWidth,
      naturalLeftBearing: natural.leftBearing,
      naturalAdvanceWidth: natural.advanceWidth,
      inkMinX: natural.inkMinX,
      inkCanvas,
    });
    return true;
  }

  function buildAndShowFont() {
    const threshold = Number(thresholdSlider.value);
    setStatus("Tracing glyphs…");

    state.glyphMetrics = new Map();
    let skipped = 0;
    state.charset.forEach((token) => {
      if (!traceTokenIntoMetrics(token, threshold)) skipped++;
    });

    if (!state.glyphMetrics.size) {
      setStatus("No ink detected in any cell — try lowering the threshold.");
      return;
    }

    state.spaceAdvanceWidth = FontCore.SPACE_ADVANCE;
    renderMetricsPanel();
    resultStage.hidden = false;
    rebuildFontAndPreview();
    setStatus(`Built font with ${state.glyphMetrics.size} glyph(s)${skipped ? `, skipped ${skipped} blank cell(s)` : ""}.`);
  }

  function rebuildFontAndPreview() {
    const familyName = document.getElementById("font-name-input").value.trim() || "MyHandwriting";
    const glyphDefs = [];
    const tokenToGid = new Map();
    let gid = 2; // 0 = .notdef, 1 = space
    state.glyphMetrics.forEach((m, token) => {
      glyphDefs.push({
        name: glyphNameFor(token),
        unicode: isLigatureToken(token) ? undefined : token.codePointAt(0),
        contours: m.contours,
        gridWidth: m.gridWidth,
        gridHeight: m.gridHeight,
        unitsPerEmWidth: m.unitsPerEmWidth,
        leftBearing: m.leftBearing,
        advanceWidth: m.advanceWidth,
      });
      tokenToGid.set(token, gid);
      gid++;
    });

    const font = FontCore.buildFont(opentype, glyphDefs, {
      familyName,
      styleName: "Regular",
      spaceAdvanceWidth: state.spaceAdvanceWidth,
    });

    // Wire "th" -> a single drawn glyph via GSUB, but only where every
    // component letter ("t", "h") was actually inked - otherwise leave the
    // ligature glyph in the font but unreachable rather than guessing.
    let ligaturesWired = 0;
    state.glyphMetrics.forEach((m, token) => {
      if (!isLigatureToken(token)) return;
      const componentGids = Array.from(token).map((c) => tokenToGid.get(c));
      if (componentGids.some((g) => g === undefined)) return;
      FontCore.addLigatureSubstitution(font, componentGids, tokenToGid.get(token));
      ligaturesWired++;
    });

    const buf = font.toArrayBuffer();
    const blob = new Blob([buf], { type: "font/ttf" });
    const url = URL.createObjectURL(blob);
    const dl = document.getElementById("download-font");
    dl.href = url;
    dl.download = familyName.replace(/[^A-Za-z0-9_-]/g, "") + ".ttf";

    // Register the rebuilt font twice: once under the user-facing
    // `familyName` (so anything referencing that exact name - other code,
    // other tabs, tests - still finds a live face there), and once under a
    // fresh, never-reused internal name every rebuild, which #font-preview
    // actually uses to render. Browsers can be inconsistent about
    // repainting already-rendered text when a FontFace's bytes change but
    // its family name doesn't, so the preview needs a genuinely new name
    // each time to force it. previewGeneration guards against rapid edits
    // (e.g. several nudge clicks) resolving out of order and a stale
    // rebuild clobbering a newer one's preview.
    previewGeneration++;
    const myGeneration = previewGeneration;
    const previewFamilyName = `FontMapperPreview${myGeneration}`;
    const namedFace = new FontFace(familyName, buf);
    const previewFace = new FontFace(previewFamilyName, buf);
    Promise.all([namedFace.load(), previewFace.load()]).then(([loadedNamed, loadedPreview]) => {
      if (myGeneration !== previewGeneration) return;
      Array.from(document.fonts)
        .filter((f) => f.family === familyName && f !== loadedNamed)
        .forEach((f) => document.fonts.delete(f));
      document.fonts.add(loadedNamed);

      Array.from(document.fonts)
        .filter((f) => f !== loadedPreview && f.family.startsWith("FontMapperPreview"))
        .forEach((f) => document.fonts.delete(f));
      document.fonts.add(loadedPreview);

      const preview = document.getElementById("font-preview");
      preview.style.fontFamily = `"${previewFamilyName}"`;
      preview.textContent = document.getElementById("preview-text").value;
    });

    state.lastFamilyName = familyName;
    state.lastLigaturesWired = ligaturesWired;
  }

  // Visual sidebearing editor: each card shows the letter's actual scanned
  // ink sitting in its advance box, with two draggable lines - drag the blue
  // line (left bearing) or the orange line (advance width) right on the
  // letter, instead of typing numbers into disconnected fields.
  function cardCanvasWidthUnits(advanceWidth) {
    return Math.max(1200, Math.round(advanceWidth * 1.8));
  }

  function drawHandle(ctx, x, height, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  function drawGlyphCard(canvas, m) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const boxLeftPx = (m.leftBearing - m.inkMinX) * PX_PER_UNIT;
    const boxWidthPx = m.unitsPerEmWidth * PX_PER_UNIT;
    ctx.drawImage(m.inkCanvas, boxLeftPx, 0, boxWidthPx, canvas.height);

    const baselineY = FontCore.BOX_TOP * PX_PER_UNIT;
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baselineY);
    ctx.lineTo(canvas.width, baselineY);
    ctx.stroke();

    drawHandle(ctx, m.leftBearing * PX_PER_UNIT, canvas.height, "#2f6feb");
    drawHandle(ctx, m.advanceWidth * PX_PER_UNIT, canvas.height, "#e0762f");
  }

  function drawSpaceCard(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawHandle(ctx, state.spaceAdvanceWidth * PX_PER_UNIT, canvas.height, "#e0762f");
  }

  function updateGlyphReadout(readout, m) {
    readout.textContent = `gap ${Math.round(m.leftBearing)} · width ${Math.round(m.advanceWidth)}`;
  }

  function nearestHandleHit(x, candidates) {
    let best = null;
    candidates.forEach(([name, pos]) => {
      const dist = Math.abs(x - pos);
      if (dist <= HANDLE_HIT_PX && (best === null || dist < best.dist)) best = { name, dist };
    });
    return best && best.name;
  }

  function attachGlyphDrag(canvas, m, readout) {
    let active = null;
    canvas.addEventListener("pointerdown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      active = nearestHandleHit(x, [
        ["left", m.leftBearing * PX_PER_UNIT],
        ["width", m.advanceWidth * PX_PER_UNIT],
      ]);
      if (active) canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!active) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(canvas.width, e.clientX - rect.left));
      const units = Math.round(x / PX_PER_UNIT / 5) * 5;
      if (active === "left") m.leftBearing = Math.max(-500, units);
      else m.advanceWidth = Math.max(20, units);
      drawGlyphCard(canvas, m);
      updateGlyphReadout(readout, m);
    });
    const release = () => { if (active) { active = null; rebuildFontAndPreview(); } };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
  }

  function attachSpaceDrag(canvas, readout) {
    let active = false;
    canvas.addEventListener("pointerdown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      active = !!nearestHandleHit(x, [["width", state.spaceAdvanceWidth * PX_PER_UNIT]]);
      if (active) canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!active) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(canvas.width, e.clientX - rect.left));
      state.spaceAdvanceWidth = Math.max(20, Math.round(x / PX_PER_UNIT / 5) * 5);
      drawSpaceCard(canvas);
      readout.textContent = `width ${state.spaceAdvanceWidth}`;
    });
    const release = () => { if (active) { active = false; rebuildFontAndPreview(); } };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
  }

  // If just one letter's crop is a little off (registration slipped, or the
  // ink sits closer to one edge of its box than expected), nudge that
  // token's source crop and re-trace only it, instead of anything global.
  // Rolls back automatically if the nudge lands on blank space.
  function nudgeAndRetrace(token, ddx, ddy) {
    if (!state.tokenSource.has(token)) {
      setStatus(`No stored scan region for "${token}" to nudge (build the font again first).`);
      return;
    }
    const prevOffset = state.cropOffsets.get(token) || { dx: 0, dy: 0 };
    const nextOffset = { dx: prevOffset.dx + ddx, dy: prevOffset.dy + ddy };
    state.cropOffsets.set(token, nextOffset);
    recropToken(token);
    const threshold = Number(thresholdSlider.value);
    const ok = traceTokenIntoMetrics(token, threshold);
    if (!ok) {
      state.cropOffsets.set(token, prevOffset);
      recropToken(token);
      traceTokenIntoMetrics(token, threshold);
      setStatus(`Nudging "${token === " " ? "␣" : token}" landed on blank space — reverted. Try the other direction or a smaller nudge.`);
      renderMetricsPanel();
      return;
    }
    renderMetricsPanel();
    rebuildFontAndPreview();
    setStatus(`Adjusted the crop for "${token === " " ? "␣" : token}" (offset ${nextOffset.dx}, ${nextOffset.dy} px).`);
  }

  function buildCropNudgeRow(token) {
    const row = document.createElement("div");
    row.className = "crop-nudge-row";
    const buttons = [
      { label: "◀", dx: -CROP_NUDGE_STEP_PX, dy: 0, title: "Nudge crop left" },
      { label: "▲", dx: 0, dy: -CROP_NUDGE_STEP_PX, title: "Nudge crop up" },
      { label: "▼", dx: 0, dy: CROP_NUDGE_STEP_PX, title: "Nudge crop down" },
      { label: "▶", dx: CROP_NUDGE_STEP_PX, dy: 0, title: "Nudge crop right" },
    ];
    buttons.forEach((b) => {
      const btn = document.createElement("button");
      btn.className = "crop-nudge-btn";
      btn.textContent = b.label;
      btn.title = b.title;
      btn.addEventListener("click", () => nudgeAndRetrace(token, b.dx, b.dy));
      row.appendChild(btn);
    });
    return row;
  }

  function buildGlyphCard(ch, m) {
    const card = document.createElement("div");
    card.className = "metrics-card";
    card.dataset.char = ch;

    const label = document.createElement("div");
    label.className = "metrics-char";
    label.textContent = ch === " " ? "␣" : ch;
    card.appendChild(label);

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(cardCanvasWidthUnits(m.advanceWidth) * PX_PER_UNIT);
    canvas.height = CARD_HEIGHT_PX;
    card.appendChild(canvas);

    const readout = document.createElement("div");
    readout.className = "hint";
    card.appendChild(readout);

    const resetBtn = document.createElement("button");
    resetBtn.className = "metrics-reset";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => {
      m.leftBearing = m.naturalLeftBearing;
      m.advanceWidth = m.naturalAdvanceWidth;
      drawGlyphCard(canvas, m);
      updateGlyphReadout(readout, m);
      rebuildFontAndPreview();
    });
    card.appendChild(resetBtn);
    card.appendChild(buildCropNudgeRow(ch));

    drawGlyphCard(canvas, m);
    updateGlyphReadout(readout, m);
    attachGlyphDrag(canvas, m, readout);
    return card;
  }

  function buildSpaceCard() {
    const card = document.createElement("div");
    card.className = "metrics-card";
    card.dataset.role = "space";

    const label = document.createElement("div");
    label.className = "metrics-char";
    label.textContent = "␣ (space)";
    card.appendChild(label);

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(cardCanvasWidthUnits(state.spaceAdvanceWidth) * PX_PER_UNIT);
    canvas.height = CARD_HEIGHT_PX;
    card.appendChild(canvas);

    const readout = document.createElement("div");
    readout.className = "hint";
    readout.textContent = `width ${state.spaceAdvanceWidth}`;
    card.appendChild(readout);

    const resetBtn = document.createElement("button");
    resetBtn.className = "metrics-reset";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => {
      state.spaceAdvanceWidth = FontCore.SPACE_ADVANCE;
      drawSpaceCard(canvas);
      readout.textContent = `width ${state.spaceAdvanceWidth}`;
      rebuildFontAndPreview();
    });
    card.appendChild(resetBtn);

    drawSpaceCard(canvas);
    attachSpaceDrag(canvas, readout);
    return card;
  }

  function renderMetricsPanel() {
    const panel = document.getElementById("metrics-panel");
    panel.innerHTML = "";
    panel.appendChild(buildSpaceCard());
    state.glyphMetrics.forEach((m, ch) => panel.appendChild(buildGlyphCard(ch, m)));
  }

  function applyGlobalSpacing() {
    const delta = Number(document.getElementById("global-spacing-delta").value) || 0;
    state.glyphMetrics.forEach((m) => { m.advanceWidth = Math.max(20, m.advanceWidth + delta); });
    state.spaceAdvanceWidth = Math.max(20, state.spaceAdvanceWidth + delta);
    renderMetricsPanel();
    rebuildFontAndPreview();
  }

  function resetAllMetrics() {
    state.glyphMetrics.forEach((m) => {
      m.leftBearing = m.naturalLeftBearing;
      m.advanceWidth = m.naturalAdvanceWidth;
    });
    state.spaceAdvanceWidth = FontCore.SPACE_ADVANCE;
    renderMetricsPanel();
    rebuildFontAndPreview();
  }

  document.getElementById("preview-text").addEventListener("input", (e) => {
    document.getElementById("font-preview").textContent = e.target.value;
  });

  // Test-only hook (no production behavior depends on this) so the headless
  // browser E2E test can read handle positions without simulating pixel-perfect drags blind.
  window.__fmTestHooks = {
    getHandle: (i) => ({ ...state.handles[i] }),
    getAllHandles: () => state.handles.map((h) => ({ ...h })),
    getGlyphMetrics: (ch) => ({ ...state.glyphMetrics.get(ch) }),
    setGlyphMetric: (ch, field, value) => {
      const m = state.glyphMetrics.get(ch);
      m[field] = value;
      const canvas = document.querySelector(`#metrics-panel .metrics-card[data-char="${ch}"] canvas`);
      const readout = document.querySelector(`#metrics-panel .metrics-card[data-char="${ch}"] .hint`);
      drawGlyphCard(canvas, m);
      updateGlyphReadout(readout, m);
      rebuildFontAndPreview();
    },
    pxPerUnit: () => PX_PER_UNIT,
  };
})();
