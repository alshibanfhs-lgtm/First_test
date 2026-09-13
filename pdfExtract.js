// pdfExtract.js — Stage 1 of the hybrid pipeline: pull the embedded text layer
// out of a PDF *without* flattening it, keeping per-span coordinates so later
// stages can reconstruct rows/columns instead of guessing from raw text order.

/**
 * @typedef {Object} TextSpan
 * @property {number} page
 * @property {number} x
 * @property {number} y        // baseline Y, PDF space (bottom-up), per page
 * @property {number} width
 * @property {number} height
 * @property {'ltr'|'rtl'} dir
 * @property {string} text
 */

async function extractPdfSpans(fileOrArrayBuffer, opts = {}) {
  const data = fileOrArrayBuffer instanceof ArrayBuffer
    ? fileOrArrayBuffer
    : await fileOrArrayBuffer.arrayBuffer();

  // pdfjsLib is loaded globally from vendor/pdf.min.js
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const spans = [];
  const pageCount = pdf.numPages;

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent({ disableCombineTextItems: false });

    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) continue;
      // item.transform = [a, b, c, d, e, f] — e,f are the x,y translation (baseline origin).
      const [a, b, c, d, e, f] = item.transform;
      const fontHeight = Math.hypot(b, d) || Math.hypot(a, c) || 10;
      // Reconstruct in top-down page coordinates for readability downstream.
      const yTop = viewport.height - f;

      spans.push({
        page: pageNum,
        x: e,
        y: yTop,
        width: item.width,
        height: fontHeight,
        dir: item.dir === 'rtl' ? 'rtl' : (item.dir === 'ltr' ? 'ltr' : detectDirHeuristic(item.str)),
        text: item.str,
        rawTransform: item.transform,
      });
    }
  }

  return { spans, pageCount };
}

function detectDirHeuristic(str) {
  const arabicChars = (str.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (str.match(/[A-Za-z]/g) || []).length;
  return arabicChars > latinChars ? 'rtl' : 'ltr';
}

/**
 * Adaptive baseline clustering: group spans into visual rows using a dynamic
 * threshold derived from the median font height on the page, rather than a
 * fixed pixel tolerance. Spans that belong to the same printed line often
 * differ by a couple of px in baseline Y (kerning, sub/superscript glyphs,
 * mixed-script line mixing) — a fixed rounding rule mis-groups those.
 */
function clusterRows(spans, { pageNum } = {}) {
  const pageSpans = spans
    .filter((s) => pageNum === undefined || s.page === pageNum)
    .slice()
    .sort((s1, s2) => s1.y - s2.y || s1.x - s2.x);

  if (pageSpans.length === 0) return [];

  const heights = pageSpans.map((s) => s.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  const threshold = Math.max(2, medianHeight * 0.5); // adaptive, not fixed

  const rows = [];
  let current = [pageSpans[0]];
  let currentBaseline = pageSpans[0].y;

  for (let i = 1; i < pageSpans.length; i++) {
    const span = pageSpans[i];
    if (Math.abs(span.y - currentBaseline) <= threshold) {
      current.push(span);
      // Recompute a running average baseline so drift doesn't accumulate.
      currentBaseline = current.reduce((s, sp) => s + sp.y, 0) / current.length;
    } else {
      rows.push(finalizeRow(current));
      current = [span];
      currentBaseline = span.y;
    }
  }
  rows.push(finalizeRow(current));
  return rows;
}

function finalizeRow(spansInRow) {
  // IMPORTANT: do not reverse the whole row purely by counting Arabic vs
  // Latin characters (spec explicitly forbids this — mixed rows like
  // "12.50 ريال" or an Arabic product name next to a Latin barcode need
  // each span kept at its own X position, not globally flipped).
  const sorted = spansInRow.slice().sort((a, b) => a.x - b.x);
  const page = sorted[0].page;
  const y = sorted.reduce((s, sp) => s + sp.y, 0) / sorted.length;
  return {
    page,
    y,
    spans: sorted,
    // Visual text left-to-right by X position; consumers that need logical
    // (reading) order for an RTL cell should reorder within that single
    // column's span only, not the whole row.
    text: sorted.map((s) => s.text).join(' ').trim(),
  };
}

/**
 * Very rough column split: cluster the X-start positions across many rows on
 * a page into bands. Used by the generic parser fallback when a merchant
 * template isn't recognized, to separate "name" / "qty" / "price" columns.
 */
function detectColumnBands(rows, maxBands = 5) {
  const starts = [];
  rows.forEach((row) => row.spans.forEach((s) => starts.push(s.x)));
  starts.sort((a, b) => a - b);
  if (starts.length === 0) return [];

  const bands = [];
  let bandStart = starts[0];
  let prev = starts[0];
  const gapThreshold = 25; // px, generous since we only need coarse bands
  starts.forEach((x) => {
    if (x - prev > gapThreshold) {
      bands.push({ start: bandStart, end: prev });
      bandStart = x;
    }
    prev = x;
  });
  bands.push({ start: bandStart, end: prev });
  return bands.slice(0, maxBands);
}

window.PdfExtract = { extractPdfSpans, clusterRows, detectColumnBands };
