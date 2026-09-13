// learning.js — closes the loop between "user corrected something" and
// "the app gets better at that vendor next time", without anyone writing a
// line of merchant-specific code. This is what makes the two hand-written
// templates (Smart Shopper, Al Hatab) the exception rather than the rule:
// every OTHER vendor's invoice starts on the general column-aware parser
// (columnParser.js) and, after a couple of corrected invoices, graduates to
// its own learned profile — entirely from real usage.
//
// Everything here is 100% local (IndexedDB) unless the person has already
// enabled cloud sync for their invoices generally — no separate network
// call is made just for learning, and no correction data is sent anywhere
// on its own (spec §12 privacy posture extends to this data too).

const MIN_INVOICES_TO_TRUST_PROFILE = 2;
const MIN_VOTE_MAJORITY = 0.6;

/** A stable-ish fingerprint for "this is probably the same vendor/template" without needing a clean merchant name. */
function deriveMerchantKey(fullText, declaredMerchant) {
  if (declaredMerchant && declaredMerchant.trim() && declaredMerchant !== 'غير معروف / Unknown') {
    return normalizeKey(declaredMerchant);
  }
  // Fall back to a fingerprint of the first few non-empty lines — stable
  // across invoices from the same POS system/template even without a
  // cleanly-extracted merchant name.
  const firstLines = fullText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join('|');
  return normalizeKey(firstLines).slice(0, 80);
}

function normalizeKey(s) {
  return (s || '').replace(/[\d\s\-–_/.,:،]+/g, '').toLowerCase();
}

/**
 * Record what the user actually changed in the review screen, and update
 * the merchant's column-role vote tally so the next invoice from the same
 * vendor is more likely to be parsed correctly without any edits at all.
 *
 * @param {object} params
 * @param {string} params.invoiceId
 * @param {string} params.merchantKey
 * @param {Array}  params.originalItems   items as first extracted (with _sourceX metadata, if column-parsed)
 * @param {Array}  params.correctedItems  items as saved after the user's edits
 */
async function recordCorrections({ invoiceId, merchantKey, originalItems, correctedItems }) {
  if (!merchantKey) return;

  const corrections = [];
  const fieldVotes = { quantity: {}, unitPrice: {}, lineTotal: {}, name: {} };

  const maxLen = Math.max(originalItems.length, correctedItems.length);
  for (let i = 0; i < maxLen; i++) {
    const orig = originalItems[i];
    const fixed = correctedItems[i];
    if (!orig || !fixed) continue; // item added/removed entirely — not a field-level correction signal

    ['name', 'quantity', 'unitPrice', 'lineTotal'].forEach((field) => {
      const before = orig[field];
      const after = fixed[field];
      const changed = field === 'name' ? String(before || '').trim() !== String(after || '').trim() : Number(before) !== Number(after);
      if (!changed) return;

      corrections.push({
        id: `${invoiceId}-${i}-${field}-${Date.now()}`,
        invoiceId,
        merchantKey,
        itemIndex: i,
        field,
        originalValue: before,
        correctedValue: after,
        createdAt: new Date().toISOString(),
      });

      // If we know which X-column produced the WRONG value, vote that
      // column DOWN for this role and let other bands compete for it next
      // time a profile is resolved; if we know which column produced the
      // value the user confirmed unchanged, that's a positive signal too
      // (handled by the "no change" path below, outside this loop).
    });
  }

  for (const c of corrections) {
    await InvoiceDB.addCorrection(c);
  }

  // Positive signal: fields the user left untouched are implicit
  // confirmations of whatever column produced them.
  const profile = (await InvoiceDB.getMerchantProfile(merchantKey)) || newProfile(merchantKey);
  correctedItems.forEach((item, i) => {
    const orig = originalItems[i];
    if (!orig || !orig._sourceX) return;
    ['quantity', 'unitPrice', 'lineTotal', 'name'].forEach((field) => {
      const before = orig[field];
      const after = item[field];
      const confirmed = field === 'name'
        ? String(before || '').trim() === String(after || '').trim()
        : Number(before) === Number(after);
      const x = orig._sourceX[field];
      if (x === null || x === undefined) return;
      voteColumn(profile, x, field, confirmed ? 1 : -1);
    });
  });

  profile.invoicesSeen = (profile.invoicesSeen || 0) + 1;
  profile.updatedAt = new Date().toISOString();
  await InvoiceDB.saveMerchantProfile(profile);
}

function newProfile(merchantKey) {
  return { merchantKey, invoicesSeen: 0, columns: [], updatedAt: new Date().toISOString() };
}

function voteColumn(profile, x, field, delta) {
  // Find (or create) the column bucket this X falls near — merchant
  // layouts are consistent invoice-to-invoice, so a small tolerance window
  // is enough to recognize "the same column" across separate PDFs.
  const TOLERANCE = 15;
  let col = profile.columns.find((c) => Math.abs(c.x - x) <= TOLERANCE);
  if (!col) {
    col = { x, votes: {} };
    profile.columns.push(col);
  }
  col.votes[field] = (col.votes[field] || 0) + delta;
}

/**
 * Resolve a profile into a confident, ready-to-use band→role mapping, or
 * null if there isn't enough consistent history yet. This is intentionally
 * conservative: a half-learned profile that's wrong is worse than falling
 * back to the general column-aware guesser, which at least varies its
 * guess per-invoice rather than confidently repeating the same mistake.
 */
function resolveProfile(profile) {
  if (!profile || profile.invoicesSeen < MIN_INVOICES_TO_TRUST_PROFILE) return null;
  if (!profile.columns || profile.columns.length === 0) return null;

  const roles = {};
  for (const col of profile.columns) {
    const entries = Object.entries(col.votes).filter(([, v]) => v > 0);
    if (entries.length === 0) continue;
    const total = entries.reduce((s, [, v]) => s + v, 0);
    entries.sort((a, b) => b[1] - a[1]);
    const [bestField, bestVotes] = entries[0];
    if (bestVotes / total >= MIN_VOTE_MAJORITY) {
      roles[bestField] = col.x;
    }
  }
  if (!roles.name || !roles.lineTotal) return null; // not enough to be useful
  return roles;
}

/**
 * Parse rows using a resolved learned profile's X positions directly,
 * without needing to re-run column-band detection or guess roles fresh.
 */
function parseWithLearnedProfile(rows, resolvedRoles, ctx) {
  const bands = Object.entries(resolvedRoles).map(([field, x], i) => ({
    id: field, xMin: x - 15, xMax: x + 15, field,
  }));
  const roleIdx = {
    nameIdx: 'name', qtyIdx: resolvedRoles.quantity !== undefined ? 'quantity' : null,
    unitPriceIdx: resolvedRoles.unitPrice !== undefined ? 'unitPrice' : null,
    lineTotalIdx: 'lineTotal',
  };
  return window.ColumnParser.parseWithColumns(rows, bands, roleIdx, ctx);
}

window.Learning = {
  deriveMerchantKey,
  recordCorrections,
  resolveProfile,
  parseWithLearnedProfile,
  MIN_INVOICES_TO_TRUST_PROFILE,
};
