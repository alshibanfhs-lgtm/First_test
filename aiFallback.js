// aiFallback.js — Stage 4 of the hybrid pipeline.
//
// Used ONLY when Stage 2 (deterministic) and Stage 3 (OCR) both fail to
// produce a financially validated result. This module never calls an AI
// service without the explicit, per-invoice consent required by spec
// section 12 ("Do not send invoices to an AI service without explicit
// user consent" / "Inform the user when AI processing will upload invoice
// content").
//
// IMPORTANT — no API key is configured in this build. Wire `AI_ENDPOINT`
// (and any auth your backend needs) before enabling this stage; until then
// `runAiFallback` throws instead of silently no-op'ing, so the pipeline
// correctly falls through to "review-required" rather than pretending AI
// extraction happened.

const AI_ENDPOINT = null; // e.g. 'https://your-backend.example.com/extract'

function buildAiPayload({ rawText, spans, ocrConfidence, candidateSection, detectedTotals, warnings }) {
  return {
    documentText: rawText,
    textCoordinates: spans.map((s) => ({ page: s.page, x: s.x, y: s.y, w: s.width, h: s.height, text: s.text })),
    ocrConfidence: ocrConfidence ?? null,
    candidateProductSection: candidateSection,
    detectedTotals,
    parsingWarnings: warnings,
    responseSchema: {
      type: 'object',
      required: ['merchant', 'items', 'subtotal', 'tax', 'discount', 'total'],
      properties: {
        merchant: { type: 'string' },
        purchaseDate: { type: 'string' },
        taxInclusive: { type: 'boolean' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'quantity', 'unitPrice', 'lineTotal'],
            properties: {
              name: { type: 'string' },
              barcode: { type: 'string' },
              quantity: { type: 'number' },
              unitPrice: { type: 'number' },
              lineTotal: { type: 'number' },
              confidence: { type: 'number' },
            },
          },
        },
        subtotal: { type: 'number' },
        tax: { type: 'number' },
        discount: { type: 'number' },
        total: { type: 'number' },
      },
    },
  };
}

/**
 * @param {Object} extractionContext - everything gathered by earlier stages.
 * @param {boolean} userConsented - must be explicitly true; caller is
 *        responsible for having shown the consent dialog first.
 */
async function runAiFallback(extractionContext, userConsented) {
  if (!userConsented) {
    throw new Error('AI_CONSENT_REQUIRED');
  }
  if (!AI_ENDPOINT) {
    throw new Error(
      'AI_ENDPOINT_NOT_CONFIGURED: wire this to your own backend before enabling Stage 4.'
    );
  }

  const payload = buildAiPayload(extractionContext);
  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`AI_FALLBACK_HTTP_${res.status}`);

  const json = await res.json();
  // Per spec section 3: valid JSON is NOT sufficient. The caller must still
  // run this through Validation.validateInvoice before accepting it — this
  // function intentionally does not mark anything as final.
  return json;
}

window.AiFallback = { runAiFallback, buildAiPayload, AI_ENDPOINT };
