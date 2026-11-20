'use strict';
const $d = id => document.getElementById(id);
let currentFiles = [];
let profiles = {};

function say(text, error = false) {
  $d('msg').textContent = text;
  $d('msg').style.color = error ? 'var(--danger)' : '';
}
function fmt(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const p = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  return `${(bytes / 1024 ** p).toFixed(p ? 1 : 0)} ${u[p]}`;
}
function slug(name) {
  return String(name).trim().replace(/\s+/g, ' ').slice(0, 40);
}

async function addFiles(list, forcedEmotion) {
  let saved = 0, skipped = [];
  for (const file of list) {
    const parts = (file.webkitRelativePath || '').split('/').filter(Boolean);
    const emotion = forcedEmotion || (parts.length > 1 ? parts[0] : '');
    const mime = emoMime(file.name);
    if (!emotion) { skipped.push(`${file.name} (emotion naam nahi)`); continue; }
    if (!mime) { skipped.push(`${file.name} (unsupported)`); continue; }
    await emoPut({ id: crypto.randomUUID(), emotion: slug(emotion), name: file.name, type: mime, size: file.size, blob: file, addedAt: Date.now() });
    saved++;
    if (!profiles[slug(emotion)]) profiles[slug(emotion)] = { emoji: '', tone: '' };
  }
  await emoSaveProfiles(profiles);
  await refresh();
  say(`${saved} file(s) saved.${skipped.length ? ' Skipped: ' + skipped.slice(0, 5).join(', ') + (skipped.length > 5 ? '…' : '') : ''}`, skipped.length > 0 && saved === 0);
}

async function refresh() {
  currentFiles = await emoAll();
  profiles = await emoProfiles();
  const grouped = {};
  for (const f of currentFiles) (grouped[f.emotion] ||= []).push(f);
  const names = Object.keys({ ...grouped, ...profiles }).sort();
  const wrap = $d('emotions');
  wrap.replaceChildren();
  $d('empty').hidden = names.length > 0;
  let total = 0;
  for (const name of names) {
    const files = (grouped[name] || []).sort((a, b) => a.name.localeCompare(b.name));
    total += files.reduce((s, f) => s + f.size, 0);
    const p = profiles[name] || { emoji: '', tone: '' };
    const card = document.createElement('div');
    card.className = 'emotion';
    card.innerHTML = `
      <h2><span>${escapeHtml(name)}</span><span class="badge">${files.length} files</span></h2>
      <div><label class="lbl">Emoji (optional)</label><input type="text" class="emoji" value="${escapeHtml(p.emoji)}" placeholder="😊 😂 🙏"></div>
      <div><label class="lbl">Tone / instructions (optional)</label><textarea class="tone" placeholder="Jaise: warm, short, respectful">${escapeHtml(p.tone)}</textarea></div>
      <ul class="files"></ul>
      <div class="row">
        <button type="button" class="add">+ Files</button>
        <button type="button" class="danger del">Emotion delete</button>
      </div>`;
    const list = card.querySelector('.files');
    if (!files.length) list.innerHTML = '<li class="muted">Koi file nahi</li>';
    for (const f of files) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${f.name} · ${fmt(f.size)}`;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'danger'; btn.textContent = '×';
      btn.onclick = async () => { await emoDelete(f.id); await refresh(); };
      li.append(span, btn);
      list.append(li);
    }
    const save = async () => {
      profiles = await emoProfiles();
      profiles[name] = { emoji: card.querySelector('.emoji').value.trim(), tone: card.querySelector('.tone').value.trim() };
      await emoSaveProfiles(profiles);
      say(`"${name}" saved.`);
    };
    card.querySelector('.emoji').addEventListener('change', save);
    card.querySelector('.tone').addEventListener('change', save);
    card.querySelector('.add').onclick = () => {
      $d('newEmotion').value = name;
      $d('fileInput').click();
    };
    card.querySelector('.del').onclick = async () => {
      if (!confirm(`"${name}" aur iski saari files delete karein?`)) return;
      for (const f of files) await emoDelete(f.id);
      profiles = await emoProfiles();
      delete profiles[name];
      await emoSaveProfiles(profiles);
      await refresh();
    };
    wrap.append(card);
  }
  $d('storage').textContent = `Library total: ${fmt(total)} (browser storage ki limit ke andar)`;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$d('pickFolder').onclick = () => $d('folderInput').click();
$d('folderInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await addFiles(files);
});
$d('pickFiles').onclick = () => {
  if (!slug($d('newEmotion').value)) { say('Pehle emotion naam likhein.', true); return; }
  $d('fileInput').click();
};
$d('fileInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  const name = slug($d('newEmotion').value);
  e.target.value = '';
  if (files.length) await addFiles(files, name);
});

refresh().catch(err => say(`Load error: ${err.message || err}`, true));
