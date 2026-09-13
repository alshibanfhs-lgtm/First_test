// db.js — IndexedDB persistence layer.
// Schema is versioned so existing local records survive upgrades (req. 9).
const DB_NAME = 'invoice-ledger';
const DB_VERSION = 2;
const STORE_INVOICES = 'invoices';
const STORE_REPORT_CACHE = 'reportCache';
const STORE_MERCHANT_PROFILES = 'merchantProfiles'; // learned column layouts per merchant
const STORE_CORRECTIONS = 'corrections';             // raw log of every user edit, for future analysis

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        const store = db.createObjectStore(STORE_INVOICES, { keyPath: 'id' });
        store.createIndex('purchaseDate', 'purchaseDate', { unique: false });
        store.createIndex('merchant', 'merchant', { unique: false });
        store.createIndex('syncState', 'syncState', { unique: false });
        db.createObjectStore(STORE_REPORT_CACHE, { keyPath: 'key' });
      }

      if (oldVersion < 2) {
        // Additive only — existing invoices/report-cache rows are untouched
        // and remain fully readable (req. 9: "existing locally stored
        // records must remain readable after the data model is upgraded").
        const profiles = db.createObjectStore(STORE_MERCHANT_PROFILES, { keyPath: 'merchantKey' });
        profiles.createIndex('updatedAt', 'updatedAt', { unique: false });
        const corrections = db.createObjectStore(STORE_CORRECTIONS, { keyPath: 'id' });
        corrections.createIndex('merchantKey', 'merchantKey', { unique: false });
        corrections.createIndex('invoiceId', 'invoiceId', { unique: false });
      }

      // Future migrations append here as `if (oldVersion < N) { ... }`
      // blocks that only ADD indexes/fields — never destructive, so
      // existing rows written under older schema versions stay readable.
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

const InvoiceDB = {
  async saveInvoice(invoice) {
    const store = await tx(STORE_INVOICES, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(invoice);
      req.onsuccess = () => resolve(invoice);
      req.onerror = () => reject(req.error);
    });
  },

  async getInvoice(id) {
    const store = await tx(STORE_INVOICES, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllInvoices() {
    const store = await tx(STORE_INVOICES, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteInvoice(id) {
    const store = await tx(STORE_INVOICES, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  async getPendingSync() {
    const all = await this.getAllInvoices();
    return all.filter((inv) => inv.syncState === 'pending' || inv.syncState === 'failed');
  },

  async clearReportCache() {
    const store = await tx(STORE_REPORT_CACHE, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  // Full memory reset (req. 10). Deletes invoices + cached reports.
  // Does NOT touch remote records by itself — that needs explicit
  // confirmation and a network round-trip, handled by sync.js.
  async resetAllLocalData() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const txn = db.transaction(
        [STORE_INVOICES, STORE_REPORT_CACHE, STORE_MERCHANT_PROFILES, STORE_CORRECTIONS],
        'readwrite'
      );
      txn.objectStore(STORE_INVOICES).clear();
      txn.objectStore(STORE_REPORT_CACHE).clear();
      txn.objectStore(STORE_MERCHANT_PROFILES).clear();
      txn.objectStore(STORE_CORRECTIONS).clear();
      txn.oncomplete = () => resolve(true);
      txn.onerror = () => reject(txn.error);
    });
  },

  // ---------- Merchant profiles (learned column layouts) ----------
  async getMerchantProfile(merchantKey) {
    const store = await tx(STORE_MERCHANT_PROFILES, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(merchantKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async saveMerchantProfile(profile) {
    const store = await tx(STORE_MERCHANT_PROFILES, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(profile);
      req.onsuccess = () => resolve(profile);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllMerchantProfiles() {
    const store = await tx(STORE_MERCHANT_PROFILES, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  // ---------- Correction log (raw edit history, drives the learning loop) ----------
  async addCorrection(correction) {
    const store = await tx(STORE_CORRECTIONS, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(correction);
      req.onsuccess = () => resolve(correction);
      req.onerror = () => reject(req.error);
    });
  },

  async getCorrectionsForMerchant(merchantKey) {
    const store = await tx(STORE_CORRECTIONS, 'readonly');
    return new Promise((resolve, reject) => {
      const idx = store.index('merchantKey');
      const req = idx.getAll(merchantKey);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },
};

window.InvoiceDB = InvoiceDB;
