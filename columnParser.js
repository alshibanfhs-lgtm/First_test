// columnParser.js — column-aware interpretation of a product section.
//
// This is the actual general-purpose foundation of the app, NOT the two
// hand-written merchant templates. Most POS-generated invoices lay their
// product section out as a real table: a name column, then quantity/price/
// total columns, each vertically aligned across many rows. The original
// single-row "trailing numbers" heuristic (still kept in generic.js as a
// last-resort fallback for genuinely free-text receipts) cannot handle
// that shape reliably. This module can, and it works the same way whether
// the column→role mapping is being *guessed* fresh (no merchant history)
// or *supplied* from a learned merchant profile (see learning.js).

/**
 * Detect column bands across a set of rows and assign each row's spans to
 * the nearest band, purely from X positions — independent of language or
 * column order (RTL invoices commonly put the name column at the highest X
 * and price/total columns at lower X, but this makes no assumption about
 * which side is which; that's resolved by classifyBands()).
 */
function buildColumnBands(rows, maxBands = 6) {
  const starts = [];
  rows.forEach((row) => (row.spans || []).forEach((s) => starts.push(s.x)));
  if (starts.length === 0) return [];
  starts.sort((a, b) => a - b);

  const bands = [];
  let bandStart = starts[0];
  let prev = starts[0];
  const gapThreshold = 20; // px — tune-free: invoices vary, but real column
                           // gutters are almost always wider than word gaps
  starts.forEach((x) => {
    if (x - prev > gapThreshold) {
      bands.push({ xMin: bandStart, xMax: prev });
      bandStart = x;
    }
    prev = x;
  });
  bands.push({ xMin: bandStart, xMax: prev });

  // Merge down to maxBands by combining the narrowest adjacent pair
  // repeatedly — keeps the result usable even on noisy layouts.
  while (bands.length > maxBands) {
    let minGapIdx = 0;
    let minGap = Infinity;
    for (let i = 0; i < bands.length - 1; i++) {
      const gap = bands[i + 1].xMin - bands[i].xMax;
      if (gap < minGap) { minGap = gap; minGapIdx = i; }
    }
    bands[minGapIdx] = { xMin: bands[minGapIdx].xMin, xMax: bands[minGapIdx + 1].xMax };
    bands.splice(minGapIdx + 1, 1);
  }

  return bands.map((b, i) => ({ id: i, xMin: b.xMin - 1, xMax: b.xMax + 1 }));
}

function bandForX(bands, x) {
  let best = null, bestDist = Infinity;
  for (const b of bands) {
    if (x >= b.xMin && x <= b.xMax) return b;
    const dist = x < b.xMin ? b.xMin - x : x - b.xMax;
    if (dist < bestDist) { bestDist = dist; best = b; }
  }
  return best;
}

/** Group a row's spans by which column band they fall into. */
function assignRowToBands(row, bands) {
  const perBand = {};
  (row.spans || []).forEach((s) => {
    const band = bandForX(bands, s.x);
    if (!band) return;
    (perBand[band.id] = perBand[band.id] || []).push(s);
  });
  return perBand;
}

/**
 * Heuristically classify each band's likely role by looking at what kind of
 * content the rows actually put there: mostly-numeric decimal columns are
 * price/total candidates, mostly-integer small columns are quantity
 * candidates, and mostly-text (rtl or long strings) columns are the name.
 * This has no knowledge of any specific merchant — it works from content
 * shape alone, which is what makes it general-purpose.
 */
function classifyBands(rows, bands) {
  const stats = bands.map(() => ({ numericDecimal: 0, numericInt: 0, text: 0, totalLen: 0, count: 0 }));

  rows.forEach((row) => {
    const perBand = assignRowToBands(row, bands);
    Object.entries(perBand).forEach(([bandId, spans]) => {
      const text = spans.map((s) => s.text).join(' ').trim();
      if (!text) return;
      const s = stats[bandId];
      s.count++;
      s.totalLen += text.length;
      if (/^\d+\.\d+$/.test(text)) s.numericDecimal++;
      else if (/^\d+$/.test(text) && text.length <= 4) s.numericInt++;
      else s.text++;
    });
  });

  // Name column = the band with the most/longest text content.
  let nameIdx = -1, maxTextScore = -1;
  stats.forEach((s, i) => {
    const score = s.text * 10 + s.totalLen;
    if (score > maxTextScore) { maxTextScore = score; nameIdx = i; }
  });

  // Remaining numeric-decimal bands, ordered left-to-right (ascending X in
  // this coordinate space), are price/total candidates; a numeric-int-heavy
  // band is the quantity candidate.
  const numericBandIdxs = stats
    .map((s, i) => ({ i, s }))
    .filter(({ i, s }) => i !== nameIdx && (s.numericDecimal > 0 || s.numericInt > 0))
    .sort((a, b) => bands[a.i].xMin - bands[b.i].xMin);

  let qtyIdx = null;
  const priceLikeIdxs = [];
  numericBandIdxs.forEach(({ i, s }) => {
    if (qtyIdx === null && s.numericInt >= s.numericDecimal && s.numericInt > 0) {
      qtyIdx = i;
    } else {
      priceLikeIdxs.push(i);
    }
  });

  return {
    nameIdx,
    qtyIdx,
    // In a 2-numeric-column table: [unitPrice, lineTotal] left-to-right.
    // In a 1-numeric-column table: that column is the lineTotal (qty=1
    // implied unless a separate qty band was found).
    unitPriceIdx: priceLikeIdxs.length >= 2 ? priceLikeIdxs[0] : null,
    lineTotalIdx: priceLikeIdxs.length >= 2 ? priceLikeIdxs[1] : priceLikeIdxs[0] ?? null,
  };
}

/**
 * Parse product-section rows using a column classification (either freshly
 * guessed via classifyBands, or supplied from a learned merchant profile).
 * Returns items plus per-item source-X metadata so the caller (learning.js)
 * can later map a user's correction back to the column that produced it.
 */
function parseWithColumns(rows, bands, roles, ctx) {
  const { Validation, ParserCommon } = ctx;
  const items = [];
  const warnings = [];

  rows.forEach((row) => {
    const text = row.text.trim();
    if (!text) return;
    if (Validation.isMetadataLabel(text)) return;

    const perBand = assignRowToBands(row, bands);
    const nameSpans = perBand[roles.nameIdx] || [];
    const name = nameSpans.map((s) => s.text).join(' ').trim();
    if (!name || Validation.isBareNumber(name)) return;

    const qtySpans = roles.qtyIdx !== null ? perBand[roles.qtyIdx] || [] : [];
    const unitPriceSpans = roles.unitPriceIdx !== null ? perBand[roles.unitPriceIdx] || [] : [];
    const lineTotalSpans = roles.lineTotalIdx !== null ? perBand[roles.lineTotalIdx] || [] : [];

    const qtyText = qtySpans.map((s) => s.text).join('');
    const lineTotalText = lineTotalSpans.map((s) => s.text).join('');
    const unitPriceText = unitPriceSpans.map((s) => s.text).join('');

    const lineTotal = ParserCommon.parseAmount(lineTotalText);
    if (lineTotal === null) return; // no plausible price data on this row at all

    const quantity = qtyText ? ParserCommon.parseAmount(ParserCommon.normalizeDigits(qtyText)) || 1 : 1;
    const unitPrice = unitPriceText
      ? ParserCommon.parseAmount(unitPriceText)
      : Validation.round2(lineTotal / quantity);

    const candidate = { name, quantity, unitPrice, lineTotal };
    if (!Validation.isPlausibleLine(candidate)) {
      warnings.push(`Column-parsed row rejected as implausible: "${name}"`);
      return;
    }

    items.push({
      ...candidate,
      confidence: 0.75,
      // Debug/learning metadata — harmless extra fields, stripped from the
      // financial model conceptually but kept on the object for the review
      // screen's correction-diffing to use; never sent to validation logic.
      _sourceX: {
        name: nameSpans[0]?.x ?? null,
        quantity: qtySpans[0]?.x ?? null,
        unitPrice: unitPriceSpans[0]?.x ?? null,
        lineTotal: lineTotalSpans[0]?.x ?? null,
      },
    });
  });

  return { items, warnings };
}

window.ColumnParser = { buildColumnBands, assignRowToBands, classifyBands, parseWithColumns, bandForX };
