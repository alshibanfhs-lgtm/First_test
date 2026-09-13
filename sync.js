// sync.js — spec section 9. Local-first: every write lands in IndexedDB
// immediately (source of truth), then this module opportunistically pushes
// pending/failed records to a remote endpoint when online, using the
// invoice's UUID as an idempotency key so retries never create duplicates.
//
// NOTE: no backend endpoint is configured in this build (there is nothing
// to sync to yet). Wire `SYNC_ENDPOINT` to your API before deploying; until
// then everything stays local (which still satisfies "works fully offline").

const SYNC_ENDPOINT = null; // e.g. 'https://your-backend.example.com/invoices'
let syncInFlight = false;

async function pushInvoice(invoice) {
  if (!SYNC_ENDPOINT) throw new Error('SYNC_ENDPOINT_NOT_CONFIGURED');
  const res = await fetch(SYNC_ENDPOINT, {
    method: 'PUT', // PUT by UUID = idempotent upsert, never a duplicate-creating POST
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': invoice.id },
    body: JSON.stringify(invoice),
  });
  if (!res.ok) throw new Error(`SYNC_HTTP_${res.status}`);
  return res.json();
}

async function syncPendingInvoices({ onProgress } = {}) {
  if (syncInFlight) return { synced: 0, failed: 0, skipped: true };
  if (!navigator.onLine) return { synced: 0, failed: 0, offline: true };

  syncInFlight = true;
  let synced = 0, failed = 0;
  try {
    const pending = await window.InvoiceDB.getPendingSync();
    for (const invoice of pending) {
      try {
        await pushInvoice(invoice);
        invoice.syncState = 'synced';
        await window.InvoiceDB.saveInvoice(invoice);
        synced++;
      } catch (e) {
        invoice.syncState = 'failed';
        invoice.lastSyncError = e.message;
        await window.InvoiceDB.saveInvoice(invoice);
        failed++;
      }
      onProgress && onProgress({ synced, failed, total: pending.length });
    }
  } finally {
    syncInFlight = false;
  }
  return { synced, failed };
}

function registerAutoSync() {
  window.addEventListener('online', () => syncPendingInvoices());
  // Also try once on startup in case we came back online while the tab was closed.
  if (navigator.onLine) syncPendingInvoices();
}

/**
 * Full remote deletion as part of "Reset Application Memory" (spec §10).
 * Only called after explicit user confirmation, and only deletes records
 * belonging to the current user (server must enforce this by auth).
 */
async function deleteAllRemoteRecords(invoiceIds) {
  if (!SYNC_ENDPOINT) return { skipped: true, reason: 'SYNC_ENDPOINT_NOT_CONFIGURED' };
  const results = await Promise.allSettled(
    invoiceIds.map((id) => fetch(`${SYNC_ENDPOINT}/${id}`, { method: 'DELETE' }))
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { failed, total: invoiceIds.length };
}

window.Sync = { syncPendingInvoices, registerAutoSync, deleteAllRemoteRecords, SYNC_ENDPOINT };
