// ui.js — wires the DOM to db.js / pipeline.js / validation.js / sync.js / barcode.js.
// Kept framework-free (plain DOM) so the whole app stays a static PWA with
// no build step, which matters for "installable iPhone PWA, offline-first".

(function () {
  'use strict';

  let currentReviewInvoice = null; // invoice draft being edited in the Review view
  let aiConsentResolver = null;

  // ---------------- Navigation ----------------
  const views = ['home', 'add', 'barcode', 'review', 'detail', 'reports', 'settings'];
  function showView(name) {
    views.forEach((v) => {
      const el = document.getElementById('view-' + v);
      if (el) el.hidden = v !== name;
    });
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
    if (name !== 'barcode') Barcode.stopScanner();
    if (name === 'home') renderInvoiceList();
    if (name === 'reports') renderReports();
    if (name === 'settings') renderSettings();
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // ---------------- Toast ----------------
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------- Confirm modal (delete / reset) ----------------
  function confirmDialog(title, body) {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirmModal');
      document.getElementById('confirmTitle').textContent = title;
      document.getElementById('confirmBody').textContent = body;
      modal.hidden = false;
      const okBtn = document.getElementById('confirmOk');
      const cancelBtn = document.getElementById('confirmCancel');
      const cleanup = (result) => {
        modal.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  // ---------------- AI consent modal ----------------
  function askAiConsent() {
    return new Promise((resolve) => {
      const modal = document.getElementById('aiConsentModal');
      modal.hidden = false;
      const acceptBtn = document.getElementById('aiConsentAccept');
      const declineBtn = document.getElementById('aiConsentDecline');
      const cleanup = (result) => {
        modal.hidden = true;
        acceptBtn.removeEventListener('click', onAccept);
        declineBtn.removeEventListener('click', onDecline);
        resolve(result);
      };
      const onAccept = () => cleanup(true);
      const onDecline = () => cleanup(false);
      acceptBtn.addEventListener('click', onAccept);
      declineBtn.addEventListener('click', onDecline);
    });
  }

  // ---------------- Network state pill ----------------
  function updateNetState() {
    const el = document.getElementById('netState');
    const online = navigator.onLine;
    el.textContent = online ? 'متصل' : 'غير متصل';
    el.classList.toggle('online', online);
  }
  window.addEventListener('online', updateNetState);
  window.addEventListener('offline', updateNetState);

  // ================= HOME: invoice list =================
  async function renderInvoiceList() {
    const listEl = document.getElementById('invoiceList');
    const emptyEl = document.getElementById('homeEmpty');
    const invoices = await InvoiceDB.getAllInvoices();
    invoices.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    if (invoices.length === 0) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    listEl.innerHTML = invoices.map((inv) => receiptCardHtml(inv)).join('');
    listEl.querySelectorAll('.receipt-card').forEach((card) => {
      card.addEventListener('click', () => openInvoiceDetail(card.dataset.id));
    });
  }

  function statusMeta(status) {
    if (status === 'valid') return { cls: 'valid', label: 'موثّقة', dot: '●' };
    if (status === 'review-required') return { cls: 'review', label: 'مراجعة مطلوبة', dot: '●' };
    return { cls: 'rejected', label: 'مرفوضة', dot: '●' };
  }

  function receiptCardHtml(inv) {
    const meta = statusMeta(inv.validationStatus);
    const total = Number.isFinite(inv.total) ? inv.total.toFixed(2) : '—';
    return `
      <div class="receipt-card status-${meta.cls}" data-id="${inv.id}">
        <div class="card-body">
          <div class="receipt-head">
            <div>
              <div class="receipt-merchant">${escapeHtml(inv.merchant || 'فاتورة')}</div>
              <div class="receipt-date">${escapeHtml(inv.purchaseDate || '')}</div>
              <span class="status-pill ${meta.cls}"><span class="dot"></span>${meta.label}</span>
            </div>
            <div class="receipt-total">${total} SAR</div>
          </div>
          <div class="receipt-meta-row">
            <span>${(inv.items || []).length} منتج</span>
            <span>${escapeHtml(inv.extractionMethod || '')}</span>
            <span>${inv.syncState === 'synced' ? '✓ متزامنة' : inv.syncState === 'failed' ? '⚠ فشل المزامنة' : '⏳ بالانتظار'}</span>
          </div>
        </div>
      </div>`;
  }

  async function openInvoiceDetail(id) {
    const inv = await InvoiceDB.getInvoice(id);
    if (!inv) return;
    const meta = statusMeta(inv.validationStatus);
    const html = `
      <div class="banner ${meta.cls}">${meta.label}${inv.validationReasons && inv.validationReasons.length ? ' — ' + escapeHtml(inv.validationReasons[0]) : ''}</div>
      <div class="receipt-card status-${meta.cls}"><div class="card-body">
        <div class="receipt-merchant">${escapeHtml(inv.merchant)}</div>
        <div class="receipt-date">${escapeHtml(inv.purchaseDate)} — ${escapeHtml(inv.extractionMethod)} / ${escapeHtml(inv.parserTemplate || '')}</div>
      </div></div>
      ${(inv.items || []).map((it, i) => `
        <div class="item-row">
          <div class="item-row-top">
            <span>${i + 1}. ${escapeHtml(it.name)}</span>
            <span class="confidence-badge ${confClass(it.confidence)}">${Math.round((it.confidence || 0) * 100)}%</span>
          </div>
          <div class="receipt-meta-row">
            <span>الكمية: ${it.quantity}</span>
            <span>سعر الوحدة: ${fmt(it.unitPrice)}</span>
            <span>الإجمالي: ${fmt(it.lineTotal)}</span>
          </div>
          ${it.barcode ? `<div class="chip">باركود: ${escapeHtml(it.barcode)}</div>` : ''}
        </div>`).join('')}
      <div class="totals-strip">
        <div class="row"><span>الإجمالي الفرعي</span><span>${fmt(inv.subtotal)}</span></div>
        <div class="row"><span>الخصم</span><span>${fmt(inv.discount)}</span></div>
        <div class="row"><span>الضريبة</span><span>${fmt(inv.tax)}</span></div>
        <div class="row grand"><span>الإجمالي</span><span>${fmt(inv.total)}</span></div>
        ${inv.calculated && inv.calculated.difference !== null && inv.calculated.difference !== undefined ? `
        <div class="row diff ${Math.abs(inv.calculated.difference) <= 0.02 ? 'zero' : ''}"><span>الفرق المحسوب</span><span>${fmt(inv.calculated.difference)}</span></div>` : ''}
      </div>`;
    document.getElementById('detailContent').innerHTML = html;
    document.getElementById('btnDeleteInvoice').onclick = () => deleteInvoiceFlow(inv.id);
    showView('detail');
  }

  document.getElementById('btnBackFromDetail').addEventListener('click', () => showView('home'));

  async function deleteInvoiceFlow(id) {
    const ok = await confirmDialog('حذف الفاتورة؟', 'سيتم حذف هذه الفاتورة ومنتجاتها بشكل نهائي من هذا الجهاز.');
    if (!ok) return;
    await InvoiceDB.deleteInvoice(id);
    toast('تم حذف الفاتورة');
    showView('home');
  }

  // ================= ADD: capture / import =================
  document.getElementById('btnScanCamera').addEventListener('click', () => document.getElementById('fileCamera').click());
  document.getElementById('btnImportImage').addEventListener('click', () => document.getElementById('fileImage').click());
  document.getElementById('btnImportPdf').addEventListener('click', () => document.getElementById('filePdf').click());
  document.getElementById('btnScanBarcode').addEventListener('click', () => startBarcodeView());

  document.getElementById('fileCamera').addEventListener('change', (e) => handleFile(e.target.files[0], 'camera'));
  document.getElementById('fileImage').addEventListener('change', (e) => handleFile(e.target.files[0], 'image'));
  document.getElementById('filePdf').addEventListener('change', (e) => handleFile(e.target.files[0], 'pdf'));

  async function handleFile(file, kind) {
    if (!file) return;
    const statusEl = document.getElementById('processingStatus');
    statusEl.innerHTML = `<div class="banner review">جارٍ قراءة الفاتورة… / Processing…</div>`;

    try {
      const draft = await Pipeline.runExtractionPipeline(file, { kind: kind === 'pdf' ? 'pdf' : 'image', consentToAi: false });

      if (draft.validationReasons && draft.validationReasons.includes('NEEDS_AI_CONSENT')) {
        const consented = await askAiConsent();
        if (consented) {
          statusEl.innerHTML = `<div class="banner review">جارٍ الاستخراج بالذكاء الاصطناعي…</div>`;
          const aiDraft = await Pipeline.runExtractionPipeline(file, { kind: kind === 'pdf' ? 'pdf' : 'image', consentToAi: true });
          statusEl.innerHTML = '';
          openReview(aiDraft);
          return;
        } else {
          statusEl.innerHTML = '';
          openReview(draft); // opens as rejected/manual — user can enter items by hand
          return;
        }
      }

      statusEl.innerHTML = '';
      openReview(draft);
    } catch (e) {
      statusEl.innerHTML = `<div class="banner rejected">تعذّرت معالجة الملف: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ---- Barcode scanning ----
  function startBarcodeView() {
    showView('barcode');
    document.getElementById('barcodeResult').innerHTML = '';
    const video = document.getElementById('barcodeVideo');
    Barcode.startScanner(video, {
      onDetect: ({ code, format }) => {
        document.getElementById('barcodeResult').innerHTML =
          `<div class="banner valid">تم العثور على باركود: ${escapeHtml(code)} (${format || ''})</div>`;
        toast('تم مسح الباركود: ' + code);
        // In a full build this would look up the product by barcode (online
        // lookup) and either attach it to the current invoice draft or offer
        // manual name/price entry per spec §11. Kept minimal here.
      },
      onError: (err) => {
        document.getElementById('barcodeResult').innerHTML =
          `<div class="banner rejected">تعذّر تشغيل الكاميرا: ${escapeHtml(err.message)}</div>`;
      },
    });
  }

  document.getElementById('btnCancelBarcode').addEventListener('click', () => { Barcode.stopScanner(); showView('add'); });
  document.getElementById('btnManualBarcodeSubmit').addEventListener('click', () => {
    const val = document.getElementById('manualBarcodeInput').value;
    if (!Barcode.isValidManualBarcode(val)) {
      toast('باركود غير صالح');
      return;
    }
    document.getElementById('barcodeResult').innerHTML = `<div class="banner valid">تم إدخال الباركود: ${escapeHtml(val)}</div>`;
  });

  // ================= REVIEW / EDIT =================
  function openReview(draft) {
    currentReviewInvoice = draft;
    // Snapshot exactly what the pipeline first produced (including any
    // _sourceX column metadata) BEFORE the user touches anything — this is
    // the "before" side of the learning diff at save time. Editing
    // currentReviewInvoice.items in place below would otherwise destroy it.
    currentReviewInvoice._originalSnapshot = JSON.parse(JSON.stringify(draft.items || []));
    renderReview();
    showView('review');
  }

  function renderReview() {
    const inv = currentReviewInvoice;
    const meta = statusMeta(inv.validationStatus);
    document.getElementById('reviewBanner').innerHTML = `
      <div class="banner ${meta.cls}">
        <div>
          <strong>${meta.label}</strong><br>
          ${(inv.validationReasons || []).map((r) => escapeHtml(r)).join('<br>')}
        </div>
      </div>`;

    document.getElementById('reviewMeta').innerHTML = `
      <div class="field"><label>التاجر / Merchant</label><input id="f_merchant" value="${escapeAttr(inv.merchant)}"></div>
      <div class="field"><label>تاريخ الشراء / Date</label><input id="f_date" type="date" value="${escapeAttr(inv.purchaseDate)}"></div>
      <div class="receipt-meta-row">
        <span>طريقة الاستخراج: ${escapeHtml(inv.extractionMethod || '')}</span>
        <span>القالب: ${escapeHtml(inv.parserTemplate || '')}</span>
      </div>`;

    document.getElementById('reviewItems').innerHTML = (inv.items || []).map((it, i) => itemRowHtml(it, i)).join('');
    document.getElementById('reviewItems').querySelectorAll('[data-idx]').forEach((input) => {
      input.addEventListener('input', onItemFieldChange);
    });
    document.getElementById('reviewItems').querySelectorAll('.btn-remove-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = Number(e.target.dataset.idx);
        inv.items.splice(idx, 1);
        recalcAndRender();
      });
    });

    renderTotals();
  }

  function itemRowHtml(it, i) {
    return `
      <div class="item-row">
        <div class="item-row-top">
          <span class="item-index">#${i + 1}</span>
          <span class="confidence-badge ${confClass(it.confidence)}">${Math.round((it.confidence || 0) * 100)}%</span>
          <button class="btn ghost small btn-remove-item" data-idx="${i}">حذف</button>
        </div>
        <div class="field"><label>اسم المنتج</label><input data-idx="${i}" data-field="name" value="${escapeAttr(it.name)}"></div>
        <div class="item-row-grid compact">
          <div class="field"><label>الباركود</label><input data-idx="${i}" data-field="barcode" value="${escapeAttr(it.barcode || '')}"></div>
          <div class="field"><label>الكمية</label><input data-idx="${i}" data-field="quantity" type="number" step="0.01" value="${it.quantity}"></div>
          <div class="field"><label>سعر الوحدة</label><input data-idx="${i}" data-field="unitPrice" type="number" step="0.01" value="${it.unitPrice}"></div>
          <div class="field"><label>الإجمالي</label><input data-idx="${i}" data-field="lineTotal" type="number" step="0.01" value="${it.lineTotal}"></div>
        </div>
      </div>`;
  }

  function onItemFieldChange(e) {
    const idx = Number(e.target.dataset.idx);
    const field = e.target.dataset.field;
    const item = currentReviewInvoice.items[idx];
    if (field === 'quantity' || field === 'unitPrice' || field === 'lineTotal') {
      item[field] = parseFloat(e.target.value) || 0;
    } else {
      item[field] = e.target.value;
    }
    recalcAndRender(false); // don't re-render inputs mid-typing, just totals+banner
  }

  function recalcAndRender(fullRerender = true) {
    currentReviewInvoice.merchant = document.getElementById('f_merchant').value;
    currentReviewInvoice.purchaseDate = document.getElementById('f_date').value;
    const validation = Validation.validateInvoice(currentReviewInvoice);
    currentReviewInvoice.validationStatus = validation.status;
    currentReviewInvoice.validationReasons = validation.reasons;
    currentReviewInvoice.calculated = validation.calculated;

    if (fullRerender) {
      renderReview();
    } else {
      const meta = statusMeta(currentReviewInvoice.validationStatus);
      document.getElementById('reviewBanner').innerHTML = `
        <div class="banner ${meta.cls}"><strong>${meta.label}</strong><br>${(currentReviewInvoice.validationReasons || []).map(escapeHtml).join('<br>')}</div>`;
      renderTotals();
    }
  }

  function renderTotals() {
    const inv = currentReviewInvoice;
    const c = inv.calculated || {};
    document.getElementById('reviewTotals').innerHTML = `
      <div class="field"><label>الإجمالي الفرعي</label><input id="f_subtotal" type="number" step="0.01" value="${inv.subtotal ?? ''}"></div>
      <div class="field"><label>الخصم</label><input id="f_discount" type="number" step="0.01" value="${inv.discount ?? 0}"></div>
      <div class="field"><label>الضريبة</label><input id="f_tax" type="number" step="0.01" value="${inv.tax ?? 0}"></div>
      <div class="field"><label>الإجمالي المطبوع</label><input id="f_total" type="number" step="0.01" value="${inv.total ?? ''}"></div>
      <div class="totals-strip">
        <div class="row"><span>مجموع سطور المنتجات</span><span>${fmt(c.sumLineTotals)}</span></div>
        <div class="row"><span>الإجمالي المحسوب</span><span>${fmt(c.calculatedTotal)}</span></div>
        <div class="row grand"><span>الإجمالي المطبوع</span><span>${fmt(c.printedTotal)}</span></div>
        <div class="row diff ${c.difference !== null && Math.abs(c.difference || 0) <= 0.02 ? 'zero' : ''}"><span>الفرق</span><span>${fmt(c.difference)}</span></div>
      </div>`;
    ['f_subtotal', 'f_discount', 'f_tax', 'f_total'].forEach((id) => {
      document.getElementById(id).addEventListener('input', (e) => {
        const map = { f_subtotal: 'subtotal', f_discount: 'discount', f_tax: 'tax', f_total: 'total' };
        currentReviewInvoice[map[id]] = parseFloat(e.target.value) || 0;
        recalcAndRender(false);
      });
    });
  }

  document.getElementById('btnAddItemManually').addEventListener('click', () => {
    currentReviewInvoice.items.push({ name: '', quantity: 1, unitPrice: 0, lineTotal: 0, confidence: 1 });
    recalcAndRender();
  });

  document.getElementById('btnDiscardInvoice').addEventListener('click', async () => {
    const ok = await confirmDialog('تجاهل الفاتورة؟', 'لن يتم حفظ أي بيانات لهذه الفاتورة.');
    if (ok) showView('home');
  });

  document.getElementById('btnSaveInvoice').addEventListener('click', async () => {
    // Recalculate one final time from current field values before persisting —
    // never silently save an invoice whose displayed validation is stale.
    recalcAndRender(false);
    const inv = currentReviewInvoice;
    if (!inv.items || inv.items.length === 0) {
      toast('أضف منتجًا واحدًا على الأقل قبل الحفظ');
      return;
    }

    // Close the learning loop: whatever the user just confirmed or fixed
    // becomes training signal for this merchant's next invoice, entirely
    // on-device. Hardcoded templates (merchantKey null) skip this — they're
    // already exact, nothing to learn.
    if (inv.merchantKey && localStorage.getItem('__learning_enabled__') !== '0') {
      try {
        await Learning.recordCorrections({
          invoiceId: inv.id,
          merchantKey: inv.merchantKey,
          originalItems: inv._originalSnapshot || [],
          correctedItems: inv.items,
        });
      } catch (e) {
        // Learning is a best-effort improvement, never a save-blocking dependency.
        console.warn('Learning.recordCorrections failed:', e);
      }
    }

    // Strip transient extraction metadata before persisting the invoice itself.
    const originalSnapshot = inv._originalSnapshot;
    delete inv._originalSnapshot;
    inv.items = inv.items.map(({ _sourceX, ...rest }) => rest);

    await InvoiceDB.saveInvoice(inv);
    toast(inv.validationStatus === 'valid' ? 'تم حفظ الفاتورة (موثّقة)' : 'تم الحفظ — مراجعة مطلوبة');
    Sync.syncPendingInvoices();
    showView('home');
  });

  // ================= REPORTS =================
  async function renderReports() {
    const invoices = await InvoiceDB.getAllInvoices();
    const el = document.getElementById('reportsContent');
    if (invoices.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="glyph">📊</div><p>لا توجد بيانات كافية لعرض التقارير بعد</p></div>`;
      return;
    }

    const byMerchant = groupSum(invoices, (inv) => inv.merchant, (inv) => inv.total || 0);
    const byMonth = groupSum(invoices, (inv) => (inv.purchaseDate || '').slice(0, 7), (inv) => inv.total || 0);
    const productFreq = {};
    invoices.forEach((inv) => (inv.items || []).forEach((it) => {
      productFreq[it.name] = (productFreq[it.name] || 0) + (Number(it.quantity) || 0);
    }));
    const topProducts = Object.entries(productFreq).sort((a, b) => b[1] - a[1]).slice(0, 6);

    el.innerHTML = `
      <div class="report-block">
        <div class="section-title">الإنفاق حسب المتجر</div>
        ${barRows(byMerchant)}
      </div>
      <div class="report-block">
        <div class="section-title">الإنفاق حسب الشهر</div>
        ${barRows(byMonth)}
      </div>
      <div class="report-block">
        <div class="section-title">المنتجات الأكثر تكرارًا</div>
        ${barRows(Object.fromEntries(topProducts), true)}
      </div>`;
  }

  function groupSum(items, keyFn, valFn) {
    const out = {};
    items.forEach((it) => {
      const k = keyFn(it) || 'غير معروف';
      out[k] = (out[k] || 0) + valFn(it);
    });
    return out;
  }

  function barRows(obj, isCount = false) {
    const entries = Object.entries(obj);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([label, v]) => `
      <div class="bar-row">
        <span class="label">${escapeHtml(label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (v / max) * 100)}%"></span></span>
        <span class="bar-value">${isCount ? v : v.toFixed(2) + ' SAR'}</span>
      </div>`).join('');
  }

  // ================= SETTINGS =================
  function renderSettings() {
    const authEl = document.getElementById('authArea');
    const signedIn = localStorage.getItem('__demo_signed_in__'); // placeholder only, see note
    authEl.innerHTML = signedIn
      ? `<div class="setting-row"><div class="setting-label">${escapeHtml(signedIn)}</div><button class="btn small" id="btnSignOut">تسجيل الخروج</button></div>`
      : `<div class="setting-row"><div class="setting-label">لم يتم تسجيل الدخول</div></div>
         <button class="btn full" id="btnSignInApple" style="margin-bottom:8px;"> الدخول بحساب Apple</button>
         <button class="btn secondary full" id="btnSignInGoogle">الدخول بحساب Google</button>
         <p style="font-size:12px;color:var(--ink-soft);margin-top:8px;">
           تسجيل الدخول الفعلي عبر Apple/Google يتطلب ربط بيانات اعتماد OAuth الخاصة بتطبيقك (Service ID لآبل، OAuth Client ID لجوجل) على الخادم الخلفي — غير مُفعّل في هذه النسخة التجريبية.
         </p>`;
    if (!signedIn) {
      document.getElementById('btnSignInApple').addEventListener('click', () => fakeSignIn('Apple'));
      document.getElementById('btnSignInGoogle').addEventListener('click', () => fakeSignIn('Google'));
    } else {
      document.getElementById('btnSignOut').addEventListener('click', () => {
        localStorage.removeItem('__demo_signed_in__');
        renderSettings();
      });
    }

    document.getElementById('syncStatusSub').textContent = navigator.onLine
      ? 'متصل — جاهز للمزامنة'
      : 'غير متصل — سيتم المزامنة عند توفر الاتصال';

    document.getElementById('aiConsentToggle').checked = localStorage.getItem('__ai_consent_default__') === '1';
    document.getElementById('aiConsentToggle').onchange = (e) => {
      localStorage.setItem('__ai_consent_default__', e.target.checked ? '1' : '0');
    };

    document.getElementById('learningToggle').checked = localStorage.getItem('__learning_enabled__') !== '0';
    document.getElementById('learningToggle').onchange = (e) => {
      localStorage.setItem('__learning_enabled__', e.target.checked ? '1' : '0');
    };
    InvoiceDB.getAllMerchantProfiles().then((profiles) => {
      const trusted = profiles.filter((p) => p.invoicesSeen >= Learning.MIN_INVOICES_TO_TRUST_PROFILE).length;
      document.getElementById('learnedMerchantsSub').textContent =
        profiles.length === 0
          ? 'لا يوجد بعد — سيبدأ التعلّم من أول فاتورة من تاجر غير مدعوم مسبقًا'
          : `${profiles.length} تاجر لديه بيانات، ${trusted} منهم وصل لثقة كافية ليُستخدم تلقائيًا`;
    });
  }

  function fakeSignIn(provider) {
    // Placeholder only — real Sign in with Apple / Google requires backend
    // OAuth wiring that isn't part of this static-file build.
    localStorage.setItem('__demo_signed_in__', `متصل عبر ${provider} (تجريبي)`);
    toast(`تم تسجيل الدخول تجريبيًا عبر ${provider}`);
    renderSettings();
  }

  document.getElementById('btnSyncNow').addEventListener('click', async () => {
    const res = await Sync.syncPendingInvoices();
    if (res.offline) toast('غير متصل بالإنترنت');
    else if (res.synced === 0 && res.failed === 0) toast('لا توجد فواتير بحاجة لمزامنة');
    else toast(`تمت مزامنة ${res.synced}، فشل ${res.failed}`);
  });

  document.getElementById('btnResetApp').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'إعادة تعيين بيانات التطبيق؟',
      'سيتم حذف جميع الفواتير والمنتجات والتقارير المخزنة محليًا بشكل نهائي. لا يمكن التراجع عن هذا الإجراء.'
    );
    if (!ok) return;
    const invoices = await InvoiceDB.getAllInvoices();
    await InvoiceDB.resetAllLocalData();
    if (navigator.onLine) {
      const ok2 = await confirmDialog('حذف النسخ السحابية أيضًا؟', 'سيتم أيضًا حذف نسخ هذه الفواتير من الخادم إن وُجدت.');
      if (ok2) await Sync.deleteAllRemoteRecords(invoices.map((i) => i.id));
    }
    toast('تمت إعادة التعيين');
    showView('home');
  });

  // ================= helpers =================
  function fmt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return Number(n).toFixed(2);
  }
  function confClass(c) {
    if (c >= 0.8) return 'high';
    if (c >= 0.5) return 'mid';
    return 'low';
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ================= init =================
  document.addEventListener('DOMContentLoaded', () => {
    updateNetState();
    renderInvoiceList();
    Sync.registerAutoSync();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {/* offline-first still works without SW registration succeeding */});
    }
  });
})();
