// Drives web/ai.mjs through real user flows with a minimal DOM and a stubbed API.
import assert from 'node:assert/strict';
import test from 'node:test';

const ELEMENT_IDS = [
  'aiLog', 'aiActions', 'aiStatus', 'aiMessage', 'aiVoiceStatus',
  'aiVoiceChecklist', 'aiVoice', 'aiVoiceAutoSend', 'aiSend', 'aiClear', 'aiForm',
];

function makeElement(tag = 'div') {
  const listeners = new Map();
  return {
    tagName: tag,
    children: [],
    dataset: {},
    attributes: {},
    textContent: '',
    value: '',
    placeholder: '',
    disabled: false,
    checked: false,
    hidden: false,
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    focus() {},
    scrollIntoView() {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    async dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) await handler(event);
      return true;
    },
    click() { return this.dispatchEvent({ type: 'click', preventDefault() {} }); },
    get allText() {
      const own = this.textContent || '';
      return [own, ...this.children.map(child => child.allText ?? '')].join('\n');
    },
  };
}

function installDom() {
  const registry = new Map(ELEMENT_IDS.map(id => [id, makeElement()]));
  const suggestions = [makeElement('button'), makeElement('button')];
  suggestions.forEach((button, index) => { button.textContent = `建議${index}`; });

  const store = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 Chrome/120' },
    configurable: true,
  });
  globalThis.document = {
    getElementById: id => registry.get(id) ?? null,
    createElement: tag => makeElement(tag),
    querySelectorAll: selector => (selector === '.ai-suggestion' ? suggestions : []),
    addEventListener() {},
  };
  window.sessionStorage.setItem('erp.id_token', 'test-token');
  return { registry, suggestions };
}

const { registry, suggestions } = installDom();
const el = id => registry.get(id);
const { initAi } = await import('../web/ai.mjs');

let routes = {};
const calls = [];
globalThis.fetch = async (path, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ path, body });
  const route = routes[path] ?? { status: 200, payload: {} };
  return {
    ok: route.status < 400,
    status: route.status,
    text: async () => JSON.stringify(route.payload),
  };
};

function setRoutes(next) {
  routes = {
    '/api/ai/normalize': { status: 200, payload: { text: null } },
    '/api/ai/actions': { status: 200, payload: [] },
    ...next,
  };
}

async function ask(message) {
  el('aiMessage').value = message;
  await el('aiForm').dispatchEvent({ type: 'submit', preventDefault() {} });
}

const chatReply = (answer, drafts = []) => ({
  status: 200,
  payload: { answer, sources: [], drafts },
});

const purchaseDraft = (id = 'draft-1') => ({
  id,
  action: 'create_purchase_order',
  title: '建立採購單',
  path: '/api/purchase-orders',
  payload: { po_id: 'PO-007', supplier_name: '台積電' },
  requires_idempotency: false,
});

function draftButtons() {
  const cards = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.attributes?.class === 'chat-draft' || node.className === 'chat-draft') cards.push(node);
    (node.children || []).forEach(walk);
  };
  el('aiLog').children.forEach(walk);
  const last = cards.at(-1);
  if (!last) return null;
  const buttons = last.children.filter(child => child.tagName === 'button');
  return { confirm: buttons[0], cancel: buttons[1], card: last };
}

initAi();
// The normalize route must echo the input so identifiers survive the round trip.
globalThis.__echoNormalize = true;

test('query turn keeps the chat usable', async () => {
  setRoutes({ '/api/ai/chat': chatReply('目前有 3 筆低庫存。') });
  await ask('有哪些低庫存料號？');

  assert.equal(el('aiSend').disabled, false);
  assert.equal(el('aiMessage').disabled, false);
  assert.match(el('aiLog').allText, /目前有 3 筆低庫存/);
});

test('typed identifiers and quantities are not rewritten', async () => {
  setRoutes({ '/api/ai/chat': chatReply('已查詢。') });
  calls.length = 0;
  await ask('收料 PO-007 數量 007 個');

  const chat = calls.find(entry => entry.path === '/api/ai/chat');
  assert.match(chat.body.message, /PO-007/);
  assert.match(chat.body.message, /數量 007 個/);
  assert.match(el('aiLog').allText, /數量 007 個/);
});

test('a draft locks the chat until the user decides', async () => {
  setRoutes({ '/api/ai/chat': chatReply('已整理草稿。', [purchaseDraft('draft-lock')]) });
  await ask('建立採購單 PO-007 供應商台積電');

  assert.equal(el('aiSend').disabled, true, '送出應被鎖住');
  assert.equal(el('aiMessage').disabled, true, '輸入框應被鎖住');
  assert.ok(suggestions.every(button => button.disabled), '建議問題應一併停用');
  assert.match(el('aiStatus').textContent, /確認送出|取消/);
});

test('cancel always releases the lock even when the server refuses', async () => {
  const buttons = draftButtons();
  assert.ok(buttons, '應該要有草稿卡');
  setRoutes({
    '/api/ai/actions/draft-lock/cancel': { status: 409, payload: { detail: '已送出的操作不可直接取消' } },
  });

  await buttons.cancel.click();

  assert.equal(el('aiMessage').disabled, false, '取消後必須解鎖');
  assert.equal(el('aiSend').disabled, false);
  assert.ok(suggestions.every(button => button.disabled === false));
  assert.match(buttons.card.allText, /操作紀錄/);
});

test('context carries the purchase order into the next turn', async () => {
  setRoutes({ '/api/ai/chat': chatReply('好的。') });
  await ask('建立採購單 PO-2026-001 供應商台積電 數量 250 個');

  calls.length = 0;
  setRoutes({ '/api/ai/chat': chatReply('已更新數量。') });
  await ask('數量改成 300');

  const chat = calls.find(entry => entry.path === '/api/ai/chat');
  assert.match(chat.body.message, /PO-2026-001/, '後續追問應沿用上一輪單號');
});

test('asking about a topic is not treated as a write request', async () => {
  setRoutes({ '/api/ai/chat': chatReply('目前沒有待處理異常。') });
  calls.length = 0;
  await ask('我有哪些異常單要處理？');

  const chat = calls.find(entry => entry.path === '/api/ai/chat');
  assert.match(chat.body.message, /需求類型：查詢/, '詢問語氣應判為查詢');
});
