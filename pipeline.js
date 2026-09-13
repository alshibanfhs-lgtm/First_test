// pipeline.js — orchestrates the hybrid extraction architecture (spec §3).
// Priority: embedded PDF text → template parser → OCR → AI. Each stage only
// runs if the previous one failed to produce a financially validated
// result, and NONE of them are trusted just because they "found a product"
// or "returned valid JSON" — everything passes through Validation.validateInvoice.

const TEMPLATES = [window.SmartShopperParser, window.AlHatabParser]; // add future merchants here — but see selectParser(): most vendors never need one written by hand.

/**
 * Choose how to parse a set of rows, in the priority order spec §7 requires
 * ("merchant-specific parsers must take priority over the generic parser"),
 * extended with one more rung that didn't exist in the original spec but is
 * what actually makes the app scale to vendors nobody hand-coded for:
 *
 *   1. A hand-written hardcoded template, if this merchant has one.
 *   2. A LEARNED profile for this merchant — built entirely from this
 *      person's own past corrections (see learning.js) — if enough history
 *      exists to trust it.
 *   3. The general column-aware parser, which also seeds the very learning
 *      data that lets step 2 kick in for this merchant next time.
 */
async function selectParser(rows, fullText, ctx) {
  const hardcoded = TEMPLATES.find((t) => t && t.matches(fullText));
  if (hardcoded) {
    return { parsed: hardcoded.parse(rows, ctx), parserTemplate: hardcoded.id, merchantKey: null };
  }

  const merchantKey = window.Learning.deriveMerchantKey(fullText, null);
  const profile = await window.InvoiceDB.getMerchantProfile(merchantKey).catch(() => null);
  const resolved = window.Learning.resolveProfile(profile);

  if (resolved) {
    const { items, warnings } = window.Learning.parseWithLearnedProfile(rows, resolved, ctx);
    if (items.length > 0) {
      const parsed = {
        parserTemplate: 'learned-' + merchantKey,
        merchant: null,
        items,
        subtotal: ctx.ParserCommon.findLabeledAmount(rows, [/subtotal/i, /الإجمالي\s*الفرعي/]),
        tax: ctx.ParserCommon.findLabeledAmount(rows, [/vat/i, /ضريبة/]),
        discount: ctx.ParserCommon.findLabeledAmount(rows, [/discount/i, /خصم/]) || 0,
        total: ctx.ParserCommon.findLabeledAmount(rows, [/grand\s*total/i, /net\s*total/i, /total/i, /الإجمالي/, /الصافي/]),
        taxInclusive: null,
        warnings,
      };
      return { parsed, parserTemplate: parsed.parserTemplate, merchantKey };
    }
  }

  const parsed = window.GenericParser.parse(rows, ctx);
  return { parsed, parserTemplate: parsed.parserTemplate || window.GenericParser.id, merchantKey };
}

async function runExtractionPipeline(fileOrImage, { kind, consentToAi, deviceMemoryGB } = {}) {
  const warnings = [];
  let spans = [];
  let extractionMethod = null;
  let parserTemplate = null;
  let rows = [];
  let parsed = null;
  let merchantKey = null;

  // ---------- Stage 1: embedded PDF text ----------
  if (kind === 'pdf') {
    try {
      const { spans: pdfSpans } = await PdfExtract.extractPdfSpans(fileOrImage);
      spans = pdfSpans;
    } catch (e) {
      warnings.push(`Stage 1 (embedded text) failed: ${e.message}`);
    }
  }

  const textUsable = kind === 'pdf' && OcrEngine.textLayerLooksUsable(spans);

  if (textUsable) {
    rows = groupSpansIntoRows(spans);
    const fullText = rows.map((r) => r.text).join('\n');

    // ---------- Stage 2: template-aware deterministic parsing ----------
    const ctx = { ParserCommon: window.ParserCommon, Validation: window.Validation };
    const selection = await selectParser(rows, fullText, ctx);
    parsed = selection.parsed;
    parserTemplate = selection.parserTemplate;
    merchantKey = selection.merchantKey || window.Learning.deriveMerchantKey(fullText, parsed.merchant);

    const invoiceDraft = toInvoiceDraft(parsed, 'embedded-text', parserTemplate, kind);
    invoiceDraft.merchantKey = merchantKey;
    const validation = Validation.validateInvoice(invoiceDraft);

    if (validation.status !== 'rejected') {
      // Even "review-required" is an acceptable stopping point — the user
      // gets to see and fix it, per spec section 5. Only a full rejection
      // (nothing plausible at all) falls through to OCR/AI.
      return finalize(invoiceDraft, validation, warnings.concat(parsed.warnings || []));
    }
    warnings.push('Stage 2 deterministic parse was structurally rejected — falling through to OCR.');
    extractionMethod = null; // don't keep a rejected method label
  }

  // ---------- Stage 3: OCR fallback ----------
  let ocrSpans = null;
  try {
    if (kind === 'pdf') {
      // Re-open the PDF to rasterize pages for OCR (Stage 1 only kept the text layer).
      const pdfjsDoc = await pdfjsLib.getDocument({ data: await fileOrImage.arrayBuffer() }).promise;
      ocrSpans = [];
      for (let p = 1; p <= pdfjsDoc.numPages; p++) {
        const page = await pdfjsDoc.getPage(p);
        const { spans: pageSpans } = await OcrEngine.ocrPage(null, { pdfPage: page, deviceMemoryGB });
        ocrSpans.push(...pageSpans);
      }
    } else {
      // camera / imported image
      const img = await loadImage(fileOrImage);
      const { spans: pageSpans } = await OcrEngine.ocrPage(img, { deviceMemoryGB });
      ocrSpans = pageSpans;
    }
  } catch (e) {
    warnings.push(`Stage 3 (OCR) unavailable: ${e.message}`);
  }

  if (ocrSpans && ocrSpans.length) {
    rows = groupSpansIntoRows(ocrSpans);
    const fullText = rows.map((r) => r.text).join('\n');
    const ctx = { ParserCommon: window.ParserCommon, Validation: window.Validation };
    const selection = await selectParser(rows, fullText, ctx);
    parsed = selection.parsed;
    parserTemplate = selection.parserTemplate;
    merchantKey = selection.merchantKey || window.Learning.deriveMerchantKey(fullText, parsed.merchant);

    const invoiceDraft = toInvoiceDraft(parsed, 'ocr', parserTemplate, kind);
    invoiceDraft.merchantKey = merchantKey;
    const validation = Validation.validateInvoice(invoiceDraft);
    if (validation.status !== 'rejected') {
      return finalize(invoiceDraft, validation, warnings.concat(parsed.warnings || []));
    }
    warnings.push('Stage 3 OCR parse was structurally rejected — falling through to AI.');
  }

  // ---------- Stage 4: AI fallback (explicit consent required) ----------
  if (!consentToAi) {
    // Do NOT call the AI stage without consent. Surface a rejected/manual
    // result instead so the review UI can ask the user and re-run.
    const emptyDraft = toInvoiceDraft({ items: [] }, 'manual', null, kind);
    return finalize(emptyDraft, { status: 'rejected', reasons: ['NEEDS_AI_CONSENT'] }, warnings);
  }

  try {
    const aiResult = await AiFallback.runAiFallback({
      rawText: rows.map((r) => r.text).join('\n'),
      spans: rows.flatMap((r) => r.spans || []),
      ocrConfidence: null,
      candidateSection: rows.map((r) => r.text),
      detectedTotals: parsed ? { subtotal: parsed.subtotal, tax: parsed.tax, discount: parsed.discount, total: parsed.total } : {},
      warnings,
    }, true);

    const invoiceDraft = toInvoiceDraft(aiResult, 'ai', 'ai-fallback-v1', kind);
    const validation = Validation.validateInvoice(invoiceDraft); // AI output is NEVER trusted just for being valid JSON
    return finalize(invoiceDraft, validation, warnings);
  } catch (e) {
    warnings.push(`Stage 4 (AI) failed or not configured: ${e.message}`);
    const emptyDraft = toInvoiceDraft({ items: [] }, 'manual', null, kind);
    return finalize(emptyDraft, { status: 'rejected', reasons: [e.message] }, warnings);
  }
}

function toInvoiceDraft(parsed, extractionMethod, parserTemplate, sourceKind) {
  return {
    id: crypto.randomUUID(),
    merchant: parsed.merchant || 'غير معروف / Unknown',
    purchaseDate: parsed.purchaseDate || new Date().toISOString().slice(0, 10),
    source: sourceKind,
    currency: 'SAR',
    items: (parsed.items || []).map((it) => ({ ...it, confidence: it.confidence ?? 0.5 })),
    subtotal: numOrNull(parsed.subtotal),
    discount: numOrNull(parsed.discount) || 0,
    tax: numOrNull(parsed.tax) || 0,
    total: numOrNull(parsed.total),
    taxInclusive: parsed.taxInclusive ?? false,
    extractionMethod,
    parserTemplate,
    validationStatus: 'review-required',
    validationReasons: [],
    createdAt: new Date().toISOString(),
    syncState: 'pending',
  };
}

function finalize(invoiceDraft, validation, warnings) {
  invoiceDraft.validationStatus = validation.status;
  invoiceDraft.validationReasons = validation.reasons || [];
  invoiceDraft.calculated = validation.calculated || {};
  invoiceDraft.parsingWarnings = warnings;
  return invoiceDraft;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function groupSpansIntoRows(spans) {
  const pages = [...new Set(spans.map((s) => s.page))];
  const allRows = [];
  pages.forEach((p) => {
    allRows.push(...PdfExtract.clusterRows(spans, { pageNum: p }));
  });
  return allRows;
}

function loadImage(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(fileOrBlob);
  });
}

window.Pipeline = { runExtractionPipeline };
