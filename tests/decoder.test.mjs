// Round-trips real barcodes through the same reader path the browser fallback uses.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const zxing = require('../web/zxing.min.js');

const ONE_D_HINTS = new Map([[
  zxing.DecodeHintType.POSSIBLE_FORMATS,
  [
    zxing.BarcodeFormat.CODE_128,
    zxing.BarcodeFormat.CODE_39,
    zxing.BarcodeFormat.EAN_13,
    zxing.BarcodeFormat.ITF,
  ],
]]);

// Mimics the canvas surface that HTMLCanvasElementLuminanceSource reads from.
function renderBarcode(text, format, width, height) {
  const matrix = new zxing.MultiFormatWriter().encode(text, format, width, height, new Map());
  const w = matrix.getWidth();
  const h = matrix.getHeight();
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const shade = matrix.get(x, y) ? 0 : 255;
      const index = (y * w + x) * 4;
      data[index] = shade;
      data[index + 1] = shade;
      data[index + 2] = shade;
      data[index + 3] = 255;
    }
  }
  return {
    width: w,
    height: h,
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data, width: w, height: h }) }),
  };
}

function decode(canvas, reader, hints) {
  try {
    const source = new zxing.HTMLCanvasElementLuminanceSource(canvas);
    return reader.decode(new zxing.BinaryBitmap(new zxing.HybridBinarizer(source)), hints).getText();
  } catch {
    return '';
  } finally {
    reader.reset();
  }
}

test('decodes a QR code carrying a purchase order id', () => {
  const canvas = renderBarcode('PO-007', zxing.BarcodeFormat.QR_CODE, 240, 240);
  assert.equal(decode(canvas, new zxing.QRCodeReader()), 'PO-007');
});

test('preserves an id that a numeric parser would mangle', () => {
  const canvas = renderBarcode('PO-0012', zxing.BarcodeFormat.QR_CODE, 240, 240);
  assert.equal(decode(canvas, new zxing.QRCodeReader()), 'PO-0012');
});

// The bundle ships no 1D writer, so Code 128 decoding can only be proven with a physical label.
test('the 1D reader handles a non-matching frame without throwing', () => {
  const canvas = renderBarcode('PO-007', zxing.BarcodeFormat.QR_CODE, 240, 240);
  const reader = new zxing.MultiFormatOneDReader(ONE_D_HINTS);
  assert.equal(decode(canvas, reader, ONE_D_HINTS), '');
});

test('returns nothing for a blank frame instead of throwing', () => {
  const size = 120;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const blank = {
    width: size,
    height: size,
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data, width: size, height: size }) }),
  };
  assert.equal(decode(blank, new zxing.QRCodeReader()), '');
  assert.equal(decode(blank, new zxing.MultiFormatOneDReader(ONE_D_HINTS), ONE_D_HINTS), '');
});
