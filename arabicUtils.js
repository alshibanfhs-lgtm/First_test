// arabicUtils.js — loaded before everything else.
//
// REAL-WORLD FINDING (from calibrating against the two supplied invoices):
// Smart Shopper's PDF text layer has a specific, consistent Arabic font/CMap
// bug: whenever the correct text has LAM (ل) immediately followed by an
// ALEF-family letter (ا, أ, إ, آ) — i.e. a lam-alef ligature such as "لا" or
// "لإ" — the extracted Unicode comes out with the two characters REVERSED
// (alef-family before lam). Examples actually observed via pdf.js on the
// real file:
//   correct  "الإجمالي"        (ا ل إ ...)  →  extracted "اإلجمالي"  (ا إ ل ...)
//   correct  "الاسم"           (ا ل ا  س م) →  extracted "االسم"     (ا ا ل س م)
//   correct  "الاستبدال"                    →  extracted "الاستبدال" reversed similarly
// This is a classic PDF/Arabic-ligature-glyph ToUnicode ordering bug, not
// random corruption — it is 100% reproducible for the same word every time,
// which is exactly why the spec calls for detecting "the Arabic font has no
// valid Unicode mapping" as a Stage-1→Stage-3 escalation trigger. Here we
// instead repair it at the *pattern-matching* layer for the small, known set
// of structural labels the parser depends on (product-section boundaries,
// totals, metadata labels) — repairing arbitrary product-name text blindly
// would risk corrupting words that legitimately contain alef-then-lam in that
// order (e.g. "قال", "مال") which look identical to the bug's output and
// cannot be told apart without a dictionary. Structural labels are a small,
// known, closed set, so building tolerant patterns for them is safe.

function flexArSource(phrase) {
  const ALEF = /[اأإآ]/;
  let out = '';
  for (const ch of phrase) {
    if (ALEF.test(ch)) {
      out += '[اأإآ]?';
    } else if (ch === ' ') {
      out += '\\s*';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/** Build a RegExp for an Arabic phrase that tolerates the lam-alef reversal bug. */
function arPattern(phrase, flags = '') {
  return new RegExp(flexArSource(phrase), flags);
}

window.ArabicUtils = { flexArSource, arPattern };
