// Covers the barcode payload parsing that decides which purchase order gets selected.
import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 Chrome/120', mediaDevices: { getUserMedia: async () => ({}) } },
  configurable: true,
});
globalThis.window = { isSecureContext: true };

const { extractScannedPoId, scannerUnsupportedMessage } = await import('../web/scanner.mjs');

test('reads a plain purchase order barcode', () => {
  assert.equal(extractScannedPoId('PO-2026-001'), 'PO-2026-001');
});

test('keeps leading zeros in the scanned id', () => {
  assert.equal(extractScannedPoId('PO-007'), 'PO-007');
});

test('pulls the id out of a QR payload that wraps it in a URL', () => {
  assert.equal(extractScannedPoId('https://erp.example.com/receive?po=PO-TEST-102'), 'PO-TEST-102');
});

test('keeps an id that has no separator, because PO01 and PO-01 differ', () => {
  assert.equal(extractScannedPoId('po01'), 'PO01');
  assert.equal(extractScannedPoId('PO-01'), 'PO-01');
  assert.equal(extractScannedPoId('po2026001'), 'PO2026001');
});

test('strips a space the scanner inserted without inventing a separator', () => {
  assert.equal(extractScannedPoId('PO 01'), 'PO01');
});

test('falls back to the raw text when no PO token is present', () => {
  assert.equal(extractScannedPoId(' mat-1001 '), 'MAT-1001');
});

test('a desktop browser without BarcodeDetector is still supported', () => {
  assert.equal(scannerUnsupportedMessage(), '', '應改用內建解碼器而非直接停用');
});

test('reports a missing camera API', () => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'old', mediaDevices: undefined },
    configurable: true,
  });
  assert.match(scannerUnsupportedMessage(), /不支援相機存取/);
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 Chrome/120', mediaDevices: { getUserMedia: async () => ({}) } },
    configurable: true,
  });
});

test('reports an insecure context before blaming the browser', () => {
  globalThis.window = { isSecureContext: false };
  assert.match(scannerUnsupportedMessage(), /HTTPS/);
  globalThis.window = { isSecureContext: true };
});
