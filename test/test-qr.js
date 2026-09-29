// Node-side round trip for the page-identity QR: encode a payload with
// qrcode-generator (rasterizing the module matrix ourselves, no DOM needed),
// decode it with jsQR, and confirm Layout's payload format survives intact -
// including tokens containing the separator-adjacent edge cases (ligatures,
// punctuation). This is the fast, no-browser check; the actual print-size
// and camera-photo robustness is covered by the browser E2E QR tests.
const assert = require("assert");
const qrcode = require("qrcode-generator");
const jsQR = require("jsqr");
const Layout = require("../layout.js");

function rasterize(qr, pxPerModule, quietModules) {
  const n = qr.getModuleCount();
  const size = (n + quietModules * 2) * pxPerModule;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  function setPixel(x, y) {
    const i = (y * size + x) * 4;
    data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      for (let dy = 0; dy < pxPerModule; dy++) {
        for (let dx = 0; dx < pxPerModule; dx++) {
          setPixel((c + quietModules) * pxPerModule + dx, (r + quietModules) * pxPerModule + dy);
        }
      }
    }
  }
  return { data, size };
}

function encodeAndDecode(payload) {
  const qr = qrcode(0, "M");
  qr.addData(payload, "Byte");
  qr.make();
  const { data, size } = rasterize(qr, 6, 4);
  const result = jsQR(data, size, size);
  return result ? result.data : null;
}

function run() {
  // Round trip through the real Layout payload format, not just a raw string.
  const chars = { kind: "chars", tokens: Layout.DEFAULT_CHARS };
  const charsPayload = Layout.qrPayloadFor(chars);
  const charsDecoded = encodeAndDecode(charsPayload);
  assert.strictEqual(charsDecoded, charsPayload, "full default charset page must round-trip through encode+decode byte-for-byte");
  assert.deepStrictEqual(Layout.parseQrPayload(charsDecoded), chars, "decoded payload must parse back to the original page descriptor");

  const ligatures = { kind: "ligature", tokens: Layout.DEFAULT_LIGATURES };
  const ligaturesPayload = Layout.qrPayloadFor(ligatures);
  const ligaturesDecoded = encodeAndDecode(ligaturesPayload);
  assert.strictEqual(ligaturesDecoded, ligaturesPayload, "default ligature page must round-trip");
  assert.deepStrictEqual(Layout.parseQrPayload(ligaturesDecoded), ligatures);

  // Tokens containing punctuation that could plausibly collide with a naive
  // separator choice (commas, quotes, spaces) must still round-trip exactly.
  const tricky = { kind: "chars", tokens: [",", '"', "'", " ", ".", "th"] };
  const trickyPayload = Layout.qrPayloadFor(tricky);
  const trickyDecoded = encodeAndDecode(trickyPayload);
  assert.strictEqual(trickyDecoded, trickyPayload);
  assert.deepStrictEqual(Layout.parseQrPayload(trickyDecoded), tricky, "punctuation/space tokens must not be dropped or split incorrectly");

  console.log("QR encode/decode round-trip tests passed.");
  console.log(`  default chars page payload: ${charsPayload.length} bytes, ligatures page: ${ligaturesPayload.length} bytes`);
}

run();
