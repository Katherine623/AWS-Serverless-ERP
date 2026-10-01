// Camera barcode capture for receiving; resolves to the raw decoded text only.
// Chrome on Windows/Linux has no BarcodeDetector, so a bundled ZXing decoder covers those platforms.
const FORMATS = ['qr_code', 'code_128', 'code_39', 'ean_13', 'itf'];
const DETECT_INTERVAL_MS = 250;
const DECODER_URL = '/assets/zxing.min.js';

const CAMERA_ERRORS = {
  NotAllowedError: '相機權限被拒絕，請按網址列左側的圖示允許相機後重試。',
  NotReadableError: '相機已被其他程式占用（例如 Teams、Zoom），請關閉後重試。',
  SecurityError: '必須在 HTTPS 或 localhost 才能使用相機。',
};

const NO_CAMERA_MESSAGE =
  '瀏覽器回報此電腦沒有任何相機。常見原因是公司的裝置政策或 Windows 隱私權設定封鎖了鏡頭；可改用下方的條碼槍或直接輸入單號。';
export function scannerUnsupportedMessage() {
  if (!window.isSecureContext) return '必須在 HTTPS 或 localhost 才能使用掃描功能。';
  if (!navigator.mediaDevices?.getUserMedia) return '此瀏覽器不支援相機存取，請改用 Chrome。';
  return '';
}

export async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'videoinput');
  } catch {
    return [];
  }
}

async function cameraErrorMessage(error) {
  const known = CAMERA_ERRORS[error?.name];
  if (known) return known;
  // NotFound/Overconstrained both mean "no camera matched", so check whether any exists at all.
  return (await listCameras()).length
     ? '找到相機但無法開啟，請在下方改選其他鏡頭。'
     : NO_CAMERA_MESSAGE;
}

// `ideal` lets the browser pick the best lens for that direction and never rejects the request.
async function openCameraStream(facing) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: facing ? { facingMode: { ideal: facing } } : true,
      audio: false,
    });
  } catch (error) {
    throw new Error(await cameraErrorMessage(error));
  }
}

function loadBundledDecoder() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = DECODER_URL;
    script.onload = () =>
      (window.ZXing ? resolve(window.ZXing) : reject(new Error('條碼解碼器載入失敗，請重新整理後再試。')));
    script.onerror = () => reject(new Error('條碼解碼器載入失敗，請重新整理後再試。'));
    document.head.append(script);
  });
}

// Reads one video frame and yields the decoded text, or '' when nothing is found.
async function createFrameDecoder() {
  if ('BarcodeDetector' in window) {
    const detector = new window.BarcodeDetector({ formats: FORMATS });
    return async video => {
      const [found] = await detector.detect(video);
      return found?.rawValue || '';
    };
  }

  const zxing = await loadBundledDecoder();
  // Dedicated readers avoid MultiFormatReader's per-frame console warnings and try fewer formats.
  const oneDimensionalHints = new Map([[
    zxing.DecodeHintType.POSSIBLE_FORMATS,
    [
      zxing.BarcodeFormat.CODE_128,
      zxing.BarcodeFormat.CODE_39,
      zxing.BarcodeFormat.EAN_13,
      zxing.BarcodeFormat.ITF,
    ],
  ]]);
  const qrReader = new zxing.QRCodeReader();
  const barcodeReader = new zxing.MultiFormatOneDReader(oneDimensionalHints);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });

  const readWith = (reader, hints) => {
    try {
      const source = new zxing.HTMLCanvasElementLuminanceSource(canvas);
      return reader.decode(new zxing.BinaryBitmap(new zxing.HybridBinarizer(source)), hints).getText();
    } catch {
      return '';
    } finally {
      reader.reset();
    }
  };

  return async video => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) return '';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return readWith(qrReader) || readWith(barcodeReader, oneDimensionalHints);
  };
}

// Returns a stop() handle; onDetected may be called repeatedly until the caller stops.
export async function startBarcodeScan({ video, onDetected, onError, facing }) {
  const unsupported = scannerUnsupportedMessage();
  if (unsupported) throw new Error(unsupported);

  const stream = await openCameraStream(facing);
  const decodeFrame = await createFrameDecoder().catch(error => {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  });

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play().catch(() => {});

  let timer = null;
  let busy = false;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  timer = setInterval(async () => {
    if (busy || video.readyState < 2) return;
    busy = true;
    try {
      const value = await decodeFrame(video);
      if (value) onDetected(value);
    } catch {
      onError?.('條碼辨識失敗，請調整距離或光線後再試。');
    } finally {
      busy = false;
    }
  }, DETECT_INTERVAL_MS);

  return stop;
}

// Barcodes often carry a URL or payload around the id, so pull the PO token when present.
// The id is never reshaped: PO01 and PO-01 are different orders.
export function extractScannedPoId(rawValue) {
  const text = String(rawValue || '').trim().toUpperCase();
  const match = text.match(/PO[-\s]?[A-Z0-9-]+/);
  return (match ? match[0] : text).replace(/\s+/g, '');
}
