'use strict';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const SETTINGS_KEY = 'waAiAssistantSettings';
const TOGGLES_KEY = 'waAiEnabledChats';
const DB_NAME = 'waAiBusinessFileVault';
const DB_VERSION = 1;
const DB_STORE = 'productFiles';
const MAX_INLINE_BINARY = 14 * 1024 * 1024;
const MAX_TEXT_ASSETS = 160000;
const AUTO_TICK_MS = 2500;

const $ = id => document.getElementById(id);
let activeTabId = null;
let activeChatKey = '';
let lastContext = null;
let isGenerating = false;

/* ---------- basic helpers ---------- */
function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}
function settings() {
  return chrome.storage.local.get(SETTINGS_KEY).then(r => r[SETTINGS_KEY] || {});
}
async function saveSettings(patch) {
  const old = await settings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...old, ...patch } });
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const p = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** p)).toFixed(p >= 3 ? 2 : 1)} ${units[p]}`;
}
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

/* ---------- business product file vault (Business mode) ---------- */
function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local file storage open nahi hui.'));
  });
}
function vaultRequest(mode, callback) {
  return openVault().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const store = tx.objectStore(DB_STORE);
    let request;
    try { request = callback(store); } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || request?.error || new Error('Storage operation failed.')); };
  }));
}
const getAllAssets = () => vaultRequest('readonly', s => s.getAll());
const putAsset = a => vaultRequest('readwrite', s => s.put(a));
const deleteAsset = id => vaultRequest('readwrite', s => s.delete(id));

function fileMime(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return ({ txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[ext] || '';
}
async function refreshStorageMeter() {
  try {
    const [estimate, assets] = await Promise.all([navigator.storage.estimate(), getAllAssets()]);
    const fileBytes = assets.reduce((sum, item) => sum + (item.size || 0), 0);
    $('storageMeter').textContent = `Product files: ${formatBytes(fileBytes)} · Browser storage: ${formatBytes(estimate.usage || 0)} used / ${formatBytes(estimate.quota || 0)} quota.`;
  } catch (error) {
    $('storageMeter').textContent = `Storage estimate unavailable: ${error.message || error}`;
  }
}
async function renderAssets() {
  const assets = (await getAllAssets()).sort((a, b) => a.name.localeCompare(b.name));
  const list = $('assetList');
  list.replaceChildren();
  $('assetEmpty').hidden = assets.length > 0;
  for (const asset of assets) {
    const row = document.createElement('div');
    row.className = 'asset-row';
    const left = document.createElement('label');
    left.className = 'asset-select';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.dataset.assetId = asset.id;
    const description = document.createElement('span');
    description.className = 'asset-description';
    description.textContent = `${asset.name} · ${formatBytes(asset.size)}`;
    left.append(check, description);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'asset-delete';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      await deleteAsset(asset.id);
      await renderAssets();
      status(`Deleted ${asset.name}.`);
    });
    row.append(left, remove);
    list.append(row);
  }
  await refreshStorageMeter();
}
async function selectedBusinessAssets() {
  if ($('mode').value !== 'business') return [];
  const selected = new Set([...$('assetList').querySelectorAll('input[data-asset-id]:checked')].map(n => n.dataset.assetId));
  if (!selected.size) return [];
  return (await getAllAssets()).filter(item => selected.has(item.id));
}
async function assetParts(assets) {
  const parts = [];
  let binaryTotal = 0, textTotal = 0;
  for (const asset of assets) {
    const mime = fileMime(asset.name);
    parts.push({ text: `Selected business file: ${asset.name}` });
    if (mime.startsWith('text/')) {
      const text = await asset.blob.text();
      textTotal += text.length;
      if (textTotal > MAX_TEXT_ASSETS) throw new Error('Selected text files 160,000 characters se zyada hain.');
      parts.push({ text: `Contents of ${asset.name}:\n${text}` });
    } else {
      binaryTotal += asset.size;
      if (binaryTotal > MAX_INLINE_BINARY) throw new Error('Selected PDF/image files 14 MB se zyada hain.');
      parts.push({ inline_data: { mime_type: mime, data: bufferToBase64(await asset.blob.arrayBuffer()) } });
    }
  }
  return parts;
}

/* ---------- emotion library: STYLE ONLY, never topics ---------- */
// Images are not sent to the model: they would be described and leak topics (e.g. a dog photo
// turning a "hello" into a dog conversation). Only tone, emoji, and text style samples are used.
async function emotionLibrary() {
  const files = await emoAll();
  const profiles = await emoProfiles();
  const names = [...new Set([...files.map(f => f.emotion), ...Object.keys(profiles)])].sort();
  const lib = {};
  for (const name of names) {
    const p = profiles[name] || {};
    const texts = [];
    for (const f of files.filter(x => x.emotion === name && x.type.startsWith('text/')).sort((a, b) => a.name.localeCompare(b.name))) {
      texts.push(`(${f.name}) ${(await f.blob.text()).slice(0, 3000)}`);
    }
    lib[name] = { emoji: p.emoji || '', tone: p.tone || '', texts: texts.join('\n---\n').slice(0, 6000) };
  }
  return lib;
}

/* ---------- chat context ---------- */
async function getActiveContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  if (!activeTabId || !tab.url?.startsWith('https://web.whatsapp.com/')) {
    return { ok: false, title: '', chatKey: '', messages: [] };
  }
  try {
    return await chrome.tabs.sendMessage(activeTabId, { type: 'WA_AI_GET_CONTEXT' });
  } catch (firstError) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 250));
      return await chrome.tabs.sendMessage(activeTabId, { type: 'WA_AI_GET_CONTEXT' });
    } catch (injectError) {
      return { ok: false, title: '', chatKey: '', messages: [], injectionError: true,
        error: injectError?.message || firstError?.message || 'Injection failed' };
    }
  }
}
let chatOn = false;

/* ---------- chat state and button (replies are handled by content.js) ---------- */
async function renderButton() {
  const toggles = (await chrome.storage.local.get(TOGGLES_KEY))[TOGGLES_KEY] || {};
  chatOn = Boolean(activeChatKey && toggles[activeChatKey]);
  const btn = $('autoBtn');
  btn.disabled = !activeChatKey;
  btn.dataset.on = String(chatOn);
  btn.textContent = chatOn ? 'AUTO REPLY: ON  (tap to stop)' : 'AUTO REPLY: OFF  (tap to start)';
}

async function refreshContext() {
  const context = await getActiveContext();
  lastContext = context;
  activeChatKey = context.chatKey || '';
  $('chatName').textContent = context.ok ? context.title :
    (context.injectionError ? 'WhatsApp page se connect nahi hua' : 'WhatsApp Web par active chat kholein');
  $('targetInfo').textContent = `Reply target: ${context.targetNumber ? '@' + context.targetNumber : 'number visible nahi (saved contact)'}`;
  await renderButton();
  if (isGenerating) return;
  if (!context.ok && !context.injectionError) status('WhatsApp Web open karke chat select karein.');
  if (context.injectionError) status(`Connection failed: ${context.error}. Site access allow karein, phir reload karein.`, true);
}

/* ---------- settings + events ---------- */
async function loadSettings() {
  const config = await settings();
  $('mode').value = config.mode || 'normal';
  $('brand').value = config.brand || '';
  $('apiKey').value = config.apiKey || '';
  if (config.model !== DEFAULT_MODEL) await saveSettings({ model: DEFAULT_MODEL });
  $('contextStatus').textContent = config.context ? `Context saved (${config.context.length} characters)` : 'No context file loaded';
  updateModeVisibility();
}
function updateModeVisibility() {
  const business = $('mode').value === 'business';
  $('brandWrap').hidden = !business;
  $('businessAssets').hidden = !business;
}

$('autoBtn').addEventListener('click', async () => {
  if (!activeChatKey) { status('WhatsApp par chat select karein.', true); return; }
  const toggles = (await chrome.storage.local.get(TOGGLES_KEY))[TOGGLES_KEY] || {};
  const turnOn = !toggles[activeChatKey];
  toggles[activeChatKey] = turnOn;
  await chrome.storage.local.set({ [TOGGLES_KEY]: toggles });
  // content.js records the current history as old and answers only messages that arrive from now on.
  await renderButton();
  status(turnOn ? 'Auto reply ON. Agla incoming message aate hi reply khud send hoga.' : 'Auto reply OFF.');
});
$('mode').addEventListener('change', async () => { updateModeVisibility(); await saveSettings({ mode: $('mode').value }); });
$('brand').addEventListener('change', () => saveSettings({ brand: $('brand').value.trim() }));
$('apiKey').addEventListener('change', () => saveSettings({ apiKey: $('apiKey').value.trim() }));
$('openDashboard').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));
$('contextFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) { status('TXT context file 1 MB se chhoti honi chahiye.', true); return; }
    const text = await file.text();
    await saveSettings({ context: text });
    $('contextStatus').textContent = `${file.name} saved (${text.length} characters)`;
  } catch (error) {
    status(`Context file load failed: ${error.message || error}`, true);
  } finally {
    event.target.value = '';
  }
});
$('assetUpload').addEventListener('change', async event => {
  const files = [...(event.target.files || [])];
  let saved = 0;
  try {
    for (const file of files) {
      const mime = fileMime(file.name);
      if (!mime) throw new Error(`${file.name}: unsupported type.`);
      await putAsset({ id: crypto.randomUUID(), name: file.name, type: mime, size: file.size, blob: file, addedAt: Date.now() });
      saved++;
    }
    status(`${saved} file(s) saved.`);
  } catch (error) {
    status(saved ? `${saved} saved; upload stopped: ${error.message}` : `Upload failed: ${error.message}`, true);
  } finally {
    event.target.value = '';
    await renderAssets();
  }
});

loadSettings()
  .then(async () => { await renderAssets(); await refreshContext(); })
  .catch(error => status(`Startup error: ${error.message || error}`, true));
setInterval(() => {
  refreshContext().catch(() => {});
}, AUTO_TICK_MS);
