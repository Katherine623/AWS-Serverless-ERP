// Probes the failure and edge paths of the AI panel that users hit when something goes wrong.
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
      return [this.textContent || '', ...this.children.map(child => child.allText ?? '')].join('\n');
    },
  };
}

const registry = new Map(ELEMENT_IDS.map(id => [id, makeElement()]));
const suggestions = [makeElement('button')];
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

const el = id => registry.get(id);
const { initAi, resetAiChat } = await import('../web/ai.mjs');

let routes = {};
const calls = [];
globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
  const route = routes[path] ?? { status: 200, payload: {} };
  return { ok: route.status < 400, status: route.status, text: async () => JSON.stringify(route.payload) };
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

const chatReply = (answer, drafts = []) => ({ status: 200, payload: { answer, sources: [], drafts } });

const draftOf = (id, path = '/api/purchase-orders') => ({
  id,
  action: 'create_purchase_order',
  title: `草稿 ${id}`,
  path,
  payload: { po_id: 'PO-1' },
  requires_idempotency: false,
});

function latestDraftButtons() {
  const cards = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.attributes?.class === 'chat-draft' || node.className === 'chat-draft') cards.push(node);
    (node.children || []).forEach(walk);
  };
  el('aiLog').children.forEach(walk);
  return cards.map(card => {
    const buttons = card.children.filter(child => child.tagName === 'button');
    return { card, confirm: buttons[0], cancel: buttons[1] };
  });
}

initAi();

test('failed confirm keeps the lock but leaves cancel usable', async () => {
  setRoutes({ '/api/ai/chat': chatReply('草稿', [draftOf('d-fail')]) });
  await ask('建立採購單 PO-1');
  const [{ confirm, cancel }] = latestDraftButtons();

  setRoutes({
    '/api/ai/actions/d-fail/confirm': { status: 409, payload: { detail: '料號已定義為其他品名' } },
  });
  await confirm.click();

  assert.equal(el('aiMessage').disabled, true, '失敗後仍應維持鎖定');
  assert.equal(cancel.disabled, false, '取消必須可再按');
  assert.equal(confirm.disabled, false, '重新送出必須可再按');

  setRoutes({ '/api/ai/actions/d-fail/cancel': { status: 200, payload: {} } });
  await cancel.click();
  assert.equal(el('aiMessage').disabled, false, '取消後必須解鎖');
});

test('clearing the conversation escapes a stuck draft', async () => {
  setRoutes({ '/api/ai/chat': chatReply('草稿', [draftOf('d-stuck')]) });
  await ask('建立採購單 PO-1');
  assert.equal(el('aiMessage').disabled, true);

  resetAiChat();
  assert.equal(el('aiMessage').disabled, false, '清除對話應解鎖');
  assert.equal(el('aiSend').disabled, false);
});

test('every draft in one reply must be resolved before asking again', async () => {
  setRoutes({ '/api/ai/chat': chatReply('兩筆草稿', [draftOf('d-a'), draftOf('d-b')]) });
  await ask('建立兩張採購單');
  const cards = latestDraftButtons();
  assert.equal(cards.length, 2);

  setRoutes({ '/api/ai/actions/d-a/cancel': { status: 200, payload: {} } });
  await cards[0].cancel.click();
  assert.equal(el('aiMessage').disabled, true, '仍有未處理草稿時不可解鎖');

  setRoutes({ '/api/ai/actions/d-b/cancel': { status: 200, payload: {} } });
  await cards[1].cancel.click();
  assert.equal(el('aiMessage').disabled, false);
});

test('an unsupported draft path still gives the user feedback', async () => {
  setRoutes({ '/api/ai/chat': chatReply('草稿', [draftOf('d-odd', '/api/not-a-real-path')]) });
  await ask('做一件奇怪的事');
  const { confirm, card } = latestDraftButtons().at(-1);
  const result = card.children.at(-1);

  await confirm.click();

  assert.notEqual(result.textContent.trim(), '', '按下確認不應毫無回應');
});

test('a failed question does not lock the chat and keeps the text', async () => {
  resetAiChat();
  setRoutes({ '/api/ai/chat': { status: 500, payload: { detail: '伺服器錯誤' } } });
  await ask('查詢庫存');

  assert.equal(el('aiMessage').disabled, false, '查詢失敗不該鎖住輸入');
  assert.equal(el('aiSend').disabled, false);
  assert.equal(el('aiMessage').value, '查詢庫存', '失敗後應保留原本輸入');
});

test('empty input is ignored', async () => {
  resetAiChat();
  calls.length = 0;
  await ask('   ');
  assert.equal(calls.filter(entry => entry.path === '/api/ai/chat').length, 0);
});
