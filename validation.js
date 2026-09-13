// validation.js — financial validation + parsing safety rules (spec sections 5 & 7).
// Nothing here decides "success" by the mere presence of a product; every rule
// below exists specifically because the old parser's happy-path was wrong.

const TOLERANCE = 0.02; // SAR, per spec section 5

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function closeEnough(a, b, tolerance = TOLERANCE) {
  return Math.abs(round2(a) - round2(b)) <= tolerance + 1e-9;
}

/**
 * A single candidate line is only a "product" if it satisfies a plausible
 * quantity × unitPrice ≈ lineTotal relationship, or is explicitly flagged
 * manual/no-price (rare edge case, still requires review).
 * This is the per-row gate described in section 7:
 * "A product row must have a plausible relationship between quantity,
 *  unit price, and line total."
 */
function isPlausibleLine(item) {
  if (!item || typeof item.name !== 'string' || !item.name.trim()) return false;

  const qty = Number(item.quantity);
  const unitPrice = Number(item.unitPrice);
  const lineTotal = Number(item.lineTotal);

  if (!Number.isFinite(qty) || qty <= 0) return false;
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return false;
  if (!Number.isFinite(lineTotal) || lineTotal < 0) return false;

  // Reject rows where the "price" is actually a barcode/product code that
  // leaked through (8-14 digit integers are barcode candidates, never money).
  if (isLikelyBarcode(unitPrice) || isLikelyBarcode(lineTotal)) return false;

  return closeEnough(qty * unitPrice, lineTotal, Math.max(TOLERANCE, lineTotal * 0.01));
}

function isLikelyBarcode(n) {
  if (!Number.isFinite(n)) return false;
  const asInt = Math.round(n);
  if (Math.abs(n - asInt) > 1e-9) return false; // has a fractional part → not a barcode
  const digits = String(Math.abs(asInt)).length;
  return digits >= 8 && digits <= 14;
}

/**
 * A raw text token must never be promoted to a product just because it mixes
 * letters and digits. This explicitly excludes the categories listed in
 * spec section 2/7: invoice numbers, receipt/staff IDs, VAT/subtotal/total
 * lines, size/weight tokens embedded in a name, Arabic quantity labels, etc.
 */
const METADATA_LABEL_PATTERNS = [
  /invoice\s*(no|number|#)/i,
  /receipt\s*(no|number|#)/i,
  /\bstore\s*(no|number|#)/i,
  /\bstaff\s*(no|id)/i,
  /\bcashier\b/i,
  /رقم\s*الفاتورة/,
  /رقم\s*الإيصال/,
  /رقم\s*المتجر/,
  /رقم\s*الفرع/,
  /رقم\s*الموظف/,
  /رقم\s*الكاشير/,
  /الكاشير/,
  /الموظف/,
  /\bvat\b/i,
  /\bضريبة/,
  /\bالقيمة\s*المضافة/,
  /\bsubtotal\b/i,
  /\bالإجمالي\s*الفرعي/,
  /\bgrand\s*total\b/i,
  /\bالإجمالي\s*النهائي/,
  /\bالإجمالي\b/,
  /\bالمجموع\b/,
  /\btotal\b/i,
  /\bchange\b/i,
  /\bالباقي\b/,
  /\bcash\b/i,
  /\bنقدا?ً?\b/,
  /\bcard\b/i,
  /\bبطاقة\b/,
  /\bالكمية\b/, // "quantity" label itself, not a product
  /\bqty\b/i,
  /\bdiscount\b/i,
  /\bخصم\b/,
  /\bloyalty\b/i,
  /\bولاء\b/,
  /\bpoints?\b/i,
  /\bنقاط\b/,
  /\bتاريخ\b/, // date
  /\bdate\b/i,
  /\btime\b/i,
  /\bالوقت\b/,
  /\bthank\s*you\b/i,
  /\bشكرا/,
];

function isMetadataLabel(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return METADATA_LABEL_PATTERNS.some((re) => re.test(trimmed));
}

/** A number alone (no accompanying descriptive text) must never become a product. */
function isBareNumber(text) {
  const t = (text || '').trim();
  if (!t) return true;
  // Strip common separators/currency and see if anything but digits remains.
  const stripped = t.replace(/[0-9٠-٩.,%\-\s]/g, '').replace(/ر\.?س\.?|SAR|sar/gi, '');
  return stripped.length === 0;
}

/**
 * Full invoice-level financial validation (spec section 5).
 * Returns { status, reasons[], calculated, difference }.
 */
function validateInvoice(invoice) {
  const reasons = [];
  const items = Array.isArray(invoice.items) ? invoice.items : [];

  if (items.length === 0) {
    return {
      status: 'rejected',
      reasons: ['لا توجد منتجات مستخرجة من الفاتورة / No products were extracted from the invoice.'],
      calculated: {},
    };
  }

  // Rule 1: quantity × unit price ≈ line total, per row.
  const lineIssues = [];
  items.forEach((item, idx) => {
    if (!isPlausibleLine(item)) {
      lineIssues.push(idx);
    }
  });
  if (lineIssues.length > 0) {
    reasons.push(
      `${lineIssues.length} سطر/سطور لا تتطابق كمية × سعر الوحدة مع الإجمالي / ${lineIssues.length} line(s) fail quantity × unit price ≈ line total.`
    );
  }

  // Rule 2: sum of line totals ≈ subtotal (when subtotal is present).
  // IMPORTANT: this comparison only applies to VAT-EXCLUSIVE pricing. When
  // taxInclusive is true, line totals already include VAT and correctly sum
  // to the grand total instead (checked below, Rule 4) — comparing them to
  // the pre-tax subtotal there would always show a false mismatch equal to
  // the VAT amount, which is not an extraction error.
  const sumLineTotals = round2(items.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0));
  let subtotalOk = true;
  if (!invoice.taxInclusive && invoice.subtotal !== undefined && invoice.subtotal !== null && invoice.subtotal !== '') {
    subtotalOk = closeEnough(sumLineTotals, Number(invoice.subtotal));
    if (!subtotalOk) {
      reasons.push(
        `مجموع سطور المنتجات (${sumLineTotals.toFixed(2)}) لا يطابق الإجمالي الفرعي المطبوع (${Number(invoice.subtotal).toFixed(2)}) / Sum of line totals doesn't match printed subtotal.`
      );
    }
  }

  // Rule 3: subtotal − discount + VAT ≈ grand total (VAT-exclusive pricing)
  // Rule 4: sum of VAT-inclusive line totals − discount ≈ net total (VAT-inclusive pricing)
  const subtotal = Number(invoice.subtotal ?? sumLineTotals);
  const discount = Number(invoice.discount || 0);
  const vat = Number(invoice.tax || 0);
  const printedTotal = Number(invoice.total);

  let totalOk = true;
  let calculatedTotal = null;
  if (Number.isFinite(printedTotal)) {
    if (invoice.taxInclusive) {
      // Line totals already include VAT; total = sum(lineTotals) - discount.
      calculatedTotal = round2(sumLineTotals - discount);
    } else {
      calculatedTotal = round2(subtotal - discount + vat);
    }
    totalOk = closeEnough(calculatedTotal, printedTotal);
    if (!totalOk) {
      reasons.push(
        `الإجمالي المحسوب (${calculatedTotal.toFixed(2)}) يختلف عن الإجمالي المطبوع (${printedTotal.toFixed(2)}) / Calculated total differs from the printed total.`
      );
    }
  } else {
    totalOk = false;
    reasons.push('لم يتم العثور على الإجمالي النهائي المطبوع / Printed grand total was not found.');
  }

  const difference = calculatedTotal !== null && Number.isFinite(printedTotal)
    ? round2(calculatedTotal - printedTotal)
    : null;

  let status = 'valid';
  if (lineIssues.length > 0 || !subtotalOk || !totalOk) {
    status = 'review-required';
  }
  // Fully broken structure (nothing plausible at all) → rejected rather than review.
  if (lineIssues.length === items.length) {
    status = 'rejected';
  }

  return {
    status,
    reasons,
    calculated: {
      sumLineTotals,
      calculatedTotal,
      printedTotal: Number.isFinite(printedTotal) ? printedTotal : null,
      difference,
    },
    lineIssues,
  };
}

window.Validation = {
  TOLERANCE,
  round2,
  closeEnough,
  isPlausibleLine,
  isLikelyBarcode,
  isMetadataLabel,
  isBareNumber,
  validateInvoice,
};
