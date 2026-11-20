'use strict';
// Shared storage for the Emotion Library (used by the side panel and the dashboard).
const EMO_DB = 'waAiEmotionLibrary';
const EMO_DB_VERSION = 1;
const EMO_STORE = 'emotionFiles';
const EMO_PROFILE_KEY = 'waAiEmotionProfiles';
const EMO_ACCEPT = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function emoMime(name) {
  return EMO_ACCEPT[String(name).split('.').pop().toLowerCase()] || '';
}

function emoOpenDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(EMO_DB, EMO_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EMO_STORE)) {
        const store = db.createObjectStore(EMO_STORE, { keyPath: 'id' });
        store.createIndex('emotion', 'emotion', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Emotion library open nahi hui.'));
  });
}

function emoTx(mode, callback) {
  return emoOpenDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(EMO_STORE, mode);
    const store = tx.objectStore(EMO_STORE);
    let request;
    try { request = callback(store); } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || request?.error || new Error('Emotion library operation failed.')); };
  }));
}

const emoAll = () => emoTx('readonly', store => store.getAll());
const emoPut = record => emoTx('readwrite', store => store.put(record));
const emoDelete = id => emoTx('readwrite', store => store.delete(id));

async function emoProfiles() {
  const result = await chrome.storage.local.get(EMO_PROFILE_KEY);
  return result[EMO_PROFILE_KEY] || {};
}
async function emoSaveProfiles(profiles) {
  await chrome.storage.local.set({ [EMO_PROFILE_KEY]: profiles });
}
