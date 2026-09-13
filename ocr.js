// ocr.js — Stage 3 of the hybrid pipeline. Only invoked when Stage 1/2
// couldn't produce a financially valid result (missing text layer, no
// Unicode mapping for the Arabic font, corrupted/replacement characters).
//
// Requires Tesseract.js (vendor/tesseract.min.js + tesseract-core/lang data).
// Those binaries are large (~10-15MB with Arabic traineddata) and are NOT
// vendored in this build to keep the deliverable light — see the "OCR
// dependency" note in the accompanying summary for how to add them.
// The interface below is stable regardless of which OCR engine ends up
// wired to it: it always returns the same {spans, rawText} shape Stage 2's
// structural parser expects, so OCR output is never accepted directly as
// final product data (spec section 3 — "OCR text must never be accepted
// directly as final product data").

const MAX_DPI = 300;
const MIN_DPI = 120;

/**
 * Render a PDF page (or an already-loaded image) to a canvas at an adaptive
 * resolution, then run OCR over it. Resolution steps down automatically if
 * the device reports low available memory, to avoid iPhone Safari crashing
 * on large canvases.
 */
async function ocrPage(pageOrImage, { pdfPage, deviceMemoryGB } = {}) {
  const dpi = chooseDpi(deviceMemoryGB);
  const canvas = await renderToCanvas(pageOrImage, dpi, pdfPage);

  if (!window.Tesseract) {
    throw new Error(
      'OCR engine not loaded. Add vendor/tesseract.min.js and Arabic+English ' +
      'traineddata before enabling Stage 3 in production.'
    );
  }

  const result = await window.Tesseract.recognize(canvas, 'ara+eng', {
    // Arabic + English combined model, matches spec requirement 5
    // ("Read Arabic, English, and bilingual invoices").
  });

  const spans = (result.data.words || []).map((w) => ({
    page: pdfPage || 1,
    x: w.bbox.x0,
    y: w.bbox.y0,
    width: w.bbox.x1 - w.bbox.x0,
    height: w.bbox.y1 - w.bbox.y0,
    dir: /[\u0600-\u06FF]/.test(w.text) ? 'rtl' : 'ltr',
    text: w.text,
    ocrConfidence: w.confidence / 100,
  }));

  return { spans, rawText: result.data.text, meanConfidence: (result.data.confidence || 0) / 100 };
}

function chooseDpi(deviceMemoryGB) {
  const mem = deviceMemoryGB || (navigator.deviceMemory || 4);
  if (mem >= 4) return MAX_DPI;
  if (mem >= 2) return 220;
  return MIN_DPI;
}

async function renderToCanvas(source, dpi, pdfPage) {
  if (pdfPage) {
    const scale = dpi / 72; // PDF default is 72 DPI
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }
  // Plain image (camera capture / imported photo).
  const canvas = document.createElement('canvas');
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;
  canvas.getContext('2d').drawImage(source, 0, 0);
  return canvas;
}

/** Heuristics that decide whether Stage 1/2 output is trustworthy enough to skip OCR. */
function textLayerLooksUsable(spans) {
  if (!spans || spans.length === 0) return false;
  const joined = spans.map((s) => s.text).join('');
  const replacementChars = (joined.match(/\uFFFD|\u25A1/g) || []).length; // � or □
  if (replacementChars / Math.max(1, joined.length) > 0.02) return false;

  // If a page is majority Arabic-range characters but every span reports
  // 'ltr' with no Arabic letters actually decoding to anything readable,
  // that's the classic "Arabic font has no valid Unicode mapping" failure
  // mode — surface it as unusable rather than silently parsing garbage.
  const looksLikePrivateUseArea = /[\uE000-\uF8FF]/.test(joined);
  if (looksLikePrivateUseArea) return false;

  return true;
}

window.OcrEngine = { ocrPage, textLayerLooksUsable, chooseDpi };
