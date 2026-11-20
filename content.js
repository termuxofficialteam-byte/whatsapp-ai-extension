(() => {
  'use strict';
  if (window.__waAiContentBridgeInstalled) return;
  window.__waAiContentBridgeInstalled = true;

  // This file is the ONLY auto-reply engine. The side panel only handles settings and the ON/OFF toggle.
  const TOGGLES_KEY = 'waAiEnabledChats';
  const TICK_MS = 2000;
  const COOLDOWN_MS = 7000;      // after each sent reply, wait before looking at new messages (human pacing)
  const MAX_SHORT_REPLY = 280;   // longer replies are sent only when the model marks them as announcements
  const handled = new Set();     // message ids already answered or intentionally ignored
  const armed = new Set();       // chats whose old history has been baselined while ON
  const sentRecent = [];         // normalized texts we sent (second guard against answering ourselves)
  let busy = false;
  let cooldownUntil = 0;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const normalize = t => String(t || '').replace(/\s+/g, ' ').trim();

  function rememberSent(text) {
    sentRecent.push(normalize(text));
    if (sentRecent.length > 30) sentRecent.shift();
  }
  function isSentText(text) {
    const n = normalize(text);
    return Boolean(n) && sentRecent.includes(n);
  }

  function chatTitle() {
    for (const selector of [
      '[data-testid="conversation-info-header-chat-title"]',
      'header [title]',
      'header span[dir="auto"]'
    ]) {
      const element = document.querySelector(selector);
      const text = element?.getAttribute('title') || element?.textContent?.trim();
      if (text && text.length < 160) return text;
    }
    return '';
  }

  function looksLikePhone(value) {
    const v = String(value || '').trim();
    const compact = v.replace(/[\s()+\-]/g, '');
    return /^\+?[\d\s()\-]+$/.test(v) && compact.length >= 7 && compact.length <= 15;
  }

  // WhatsApp Web data-id looks like "true_<chat>_<msgId>_<senderJid>" (true = sent by me, false = received).
  // In groups the last part is the sender's JID, e.g. 923001234567@c.us, which gives the real number even for saved contacts.
  function parseDataId(dataId) {
    const parts = String(dataId || '').split('_');
    const valid = parts[0] === 'true' || parts[0] === 'false';
    const fromMe = parts[0] === 'true';
    const isGroup = /@g\.us/.test(dataId);
    const last = parts[parts.length - 1] || '';
    const m = last.match(/^(\d{6,15})@(c\.us|s\.whatsapp\.net)$/);
    return { valid, fromMe, isGroup, number: !fromMe && m ? m[1] : '' };
  }

  function getMessages() {
    const pane = document.querySelector('[data-testid="conversation-panel-messages"]') ||
      document.querySelector('[data-testid="conversation-panel-body"]') ||
      document.querySelector('[role="application"] [data-testid*="conversation-panel"]');
    if (!pane) return [];
    return [...pane.querySelectorAll('[data-testid="msg-container"]')].slice(-120).map(row => {
      const metadata = row.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') || '';
      const rawAuthor = metadata.match(/\]\s([^:]+):/)?.[1]?.trim() || '';
      const dataId = row.closest('[data-id]')?.getAttribute('data-id') || row.querySelector('[data-id]')?.getAttribute('data-id') || '';
      const parsed = parseDataId(dataId);
      const outgoing = parsed.valid ? parsed.fromMe :
        Boolean(row.closest('.message-out')) || Boolean(row.querySelector('[data-testid="msg-dblcheck"], [data-testid="msg-check"], [data-testid="msg-time"]'));
      const text = [...row.querySelectorAll('span.selectable-text, [data-testid="msg-text"]')]
        .map(node => node.innerText || node.textContent || '').join(' ').trim();
      const number = parsed.number || (!outgoing && looksLikePhone(rawAuthor) ? rawAuthor.replace(/\D/g, '') : '');
      return {
        id: dataId || `${rawAuthor}|${text}`,
        author: outgoing ? 'You' : (rawAuthor || 'Member'),
        text,
        number,
        outgoing,
        isGroup: parsed.isGroup
      };
    }).filter(item => item.text);
  }

  function insertDraft(text) {
    const editor = document.querySelector('[data-testid="conversation-compose-box-input"]') ||
      document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('footer [contenteditable="true"]');
    if (!editor || !editor.isConnected) throw new Error('WhatsApp composer nahi mila.');
    if ((editor.innerText || editor.textContent || '').trim()) throw new Error('Composer mein aapka apna text hai, reply skip kiya.');
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch (_) {}
    if (!inserted) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    }
  }

  function sendDraft() {
    const button = document.querySelector('[data-testid="send"]') ||
      document.querySelector('span[data-icon="send"]')?.closest('button') ||
      document.querySelector('footer button[aria-label="Send"]');
    if (!button) throw new Error('WhatsApp send button nahi mila.');
    button.click();
  }

  async function setStatus(text) {
    try { await chrome.storage.local.set({ waAiLastStatus: { text, at: Date.now() } }); } catch (_) {}
  }

  async function tick() {
    if (busy || Date.now() < cooldownUntil) return;
    const title = chatTitle();
    const messages = getMessages();
    if (!title || !messages.length) return;
    const chatKey = `chat:${title}`;
    const toggles = (await chrome.storage.local.get(TOGGLES_KEY))[TOGGLES_KEY] || {};
    const enabled = Boolean(toggles[chatKey]);

    // OFF: remember everything visible and forget the baseline so the next ON starts fresh.
    if (!enabled) {
      messages.forEach(m => handled.add(m.id));
      armed.delete(chatKey);
      return;
    }
    // First time ON for this chat: everything already on screen is old history, never answered.
    if (!armed.has(chatKey)) {
      messages.forEach(m => handled.add(m.id));
      armed.add(chatKey);
      return;
    }

    // Our own messages are never answered, whatever the DOM says about them.
    const fresh = messages.filter(m => !handled.has(m.id) && !m.outgoing && !isSentText(m.text));
    messages.forEach(m => { if (m.outgoing || isSentText(m.text)) handled.add(m.id); });
    if (!fresh.length) return;

    // Whatever arrived since the last check becomes ONE batch: answered once, then marked handled.
    fresh.forEach(m => handled.add(m.id));
    const latest = fresh.at(-1);

    busy = true;
    try {
      await setStatus('Naya message aaya, reply ban raha hai…');
      const response = await chrome.runtime.sendMessage({
        type: 'WA_AI_REPLY',
        messages: messages.slice(-120),
        isGroup: latest.isGroup
      });
      if (!response?.ok) throw new Error(response?.error || 'Reply generate nahi hua.');
      if (response.skip) { await setStatus('Is message par reply ki zaroorat nahi thi.'); return; }

      const body = String(response.reply || '').trim();
      if (!body) return;
      if (body.length > MAX_SHORT_REPLY && !response.announcement) {
        await setStatus('Reply lamba tha aur announcement nahi tha, isliye nahi bheja.');
        return;
      }

      // Mention the sender's number only in group chats, and only when we actually have it.
      const mention = latest.isGroup && latest.number ? `@${latest.number} ` : '';
      const text = mention + body;
      rememberSent(text);
      insertDraft(text);
      await sleep(600);
      sendDraft();
      cooldownUntil = Date.now() + COOLDOWN_MS;
      const extra = response.emotion && response.emotion !== 'none' ? ` (emotion: ${response.emotion})` : '';
      const note = latest.isGroup && !latest.number ? ' · group member ka number nahi mila, mention nahi laga' : '';
      await setStatus(`Reply bheja gaya${extra}${note}`);
    } catch (error) {
      await setStatus(`Auto reply error: ${error.message || error}`);
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'WA_AI_GET_CONTEXT') {
      const title = chatTitle();
      const messages = getMessages();
      const targetNumber = [...messages].reverse().find(m => m.author !== 'You')?.number || '';
      sendResponse({ ok: Boolean(title), title, chatKey: title ? `chat:${title}` : '', targetNumber, messages });
    }
    return false;
  });

  setInterval(() => { tick().catch(() => {}); }, TICK_MS);
})();
