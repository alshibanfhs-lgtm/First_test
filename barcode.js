// barcode.js — spec section 11.
// Uses ZXing (vendor/zxing.min.js) rather than the Shape Detection API's
// BarcodeDetector, because BarcodeDetector is not available in iOS Safari —
// and iPhone Safari support is an explicit requirement of this app.

const SUPPORTED_FORMATS = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128'];

let controls = null;
let lastCode = null;
let lastCodeAt = 0;
const DUPLICATE_WINDOW_MS = 2500;

async function startScanner(videoEl, { onDetect, onError } = {}) {
  if (!window.ZXingBrowser && !window.ZXing) {
    onError && onError(new Error('لم يتم تحميل مكتبة قراءة الباركود / Barcode library not loaded.'));
    return;
  }
  const ZXingLib = window.ZXingBrowser || window.ZXing;

  try {
    const hints = new Map();
    const formats = SUPPORTED_FORMATS.map((f) => ZXingLib.BarcodeFormat[f]).filter(Boolean);
    if (formats.length) hints.set(ZXingLib.DecodeHintType.POSSIBLE_FORMATS, formats);

    const reader = new ZXingLib.BrowserMultiFormatReader(hints);
    const devices = await ZXingLib.BrowserCodeReader.listVideoInputDevices();
    const rearCamera = devices.find((d) => /back|rear|environment/i.test(d.label)) || devices[devices.length - 1];

    controls = await reader.decodeFromVideoDevice(
      rearCamera ? rearCamera.deviceId : undefined,
      videoEl,
      (result, err) => {
        if (result) {
          const code = result.getText();
          const now = Date.now();
          if (code === lastCode && now - lastCodeAt < DUPLICATE_WINDOW_MS) {
            return; // prevent repeated scans of the same barcode
          }
          lastCode = code;
          lastCodeAt = now;
          onDetect && onDetect({ code, format: result.getBarcodeFormat?.() });
        }
        // NotFoundException fires continuously while no code is in frame —
        // that's expected, not a real error, so it's deliberately ignored here.
      }
    );
  } catch (e) {
    onError && onError(e);
  }
}

function stopScanner() {
  if (controls && controls.stop) controls.stop();
  controls = null;
  lastCode = null;
}

/** Manual barcode entry validation (basic length/checksum-shape check only). */
function isValidManualBarcode(code) {
  const trimmed = (code || '').trim();
  return /^\d{6,14}$/.test(trimmed);
}

window.Barcode = { startScanner, stopScanner, isValidManualBarcode, SUPPORTED_FORMATS };
