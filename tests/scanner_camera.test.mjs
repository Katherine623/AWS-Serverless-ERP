// Covers camera selection: laptops expose only a front camera, so the environment request must degrade.
import assert from 'node:assert/strict';
import test from 'node:test';

const tracks = [{ stop() {} }];
const fakeStream = { getTracks: () => tracks };

function setupNavigator({ onRequest, devices = [] }) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 Chrome/120',
      mediaDevices: {
        getUserMedia: async constraints => onRequest(constraints.video),
        enumerateDevices: async () => devices,
      },
    },
    configurable: true,
  });
}

function rejectWith(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

// A native detector stub keeps these tests off the bundled decoder, which needs a real DOM.
globalThis.window = {
  isSecureContext: true,
  BarcodeDetector: class {
    async detect() { return []; }
  },
};
const { listCameras, startBarcodeScan } = await import('../web/scanner.mjs');

const stubVideo = {
  srcObject: null,
  readyState: 0,
  videoWidth: 0,
  videoHeight: 0,
  setAttribute() {},
  play: async () => {},
};

test('asks for any camera when no direction is chosen', async () => {
  const requested = [];
  setupNavigator({
    onRequest: async video => {
      requested.push(video);
      return fakeStream;
    },
  });

  const stop = await startBarcodeScan({ video: { ...stubVideo }, onDetected() {} });
  stop();

  assert.deepEqual(requested, [true]);
});

test('asks for a direction, not a specific lens', async () => {
  const requested = [];
  setupNavigator({
    onRequest: async video => {
      requested.push(video);
      return fakeStream;
    },
  });

  const stop = await startBarcodeScan({
    video: { ...stubVideo },
    facing: 'environment',
    onDetected() {},
  });
  stop();

  // `ideal` lets the phone choose the right back lens instead of listing every lens.
  assert.deepEqual(requested, [{ facingMode: { ideal: 'environment' } }]);
});

test('stops retrying once the user denies permission', async () => {
  const requested = [];
  setupNavigator({ onRequest: async video => { requested.push(video); throw rejectWith('NotAllowedError'); } });

  await assert.rejects(
    startBarcodeScan({ video: { ...stubVideo }, onDetected() {} }),
    /允許相機/,
  );
  assert.equal(requested.length, 1, '權限被拒時不應再試其他相機');
});

test('tells the user why no camera exists and offers the keyboard route', async () => {
  setupNavigator({ onRequest: async () => { throw rejectWith('NotFoundError'); }, devices: [] });

  await assert.rejects(
    startBarcodeScan({ video: { ...stubVideo }, onDetected() {} }),
    /條碼槍/,
  );
});

test('points at the lens selector when a camera exists but cannot open', async () => {
  setupNavigator({
    onRequest: async () => { throw rejectWith('OverconstrainedError'); },
    devices: [{ kind: 'videoinput', deviceId: 'cam-1', label: '整合式相機' }],
  });

  await assert.rejects(
    startBarcodeScan({ video: { ...stubVideo }, onDetected() {} }),
    /改選其他鏡頭/,
  );
});

test('counts every lens so the selector only appears when there is a choice', async () => {
  setupNavigator({
    onRequest: async () => fakeStream,
    devices: [
      { kind: 'audioinput', deviceId: 'mic-1', label: '麥克風' },
      { kind: 'videoinput', deviceId: 'cam-1', label: '前置相機' },
      { kind: 'videoinput', deviceId: 'cam-2', label: '後置相機' },
    ],
  });

  assert.deepEqual((await listCameras()).map(camera => camera.deviceId), ['cam-1', 'cam-2']);
});
