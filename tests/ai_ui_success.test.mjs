// Confirms what the user sees after a draft is successfully written.
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
  };
}

const registry = new Map(ELEMENT_IDS.map(id => [id, makeElement()]));
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
  getElementById: id => registry.get(id) ?? makeElement(),
  createElement: tag => makeElement(tag),
  querySelectorAll: () => [],
  addEventListener() {},
};
window.sessionStorage.setItem('erp.id_token', 'test-token');

const el = id => registry.get(id);
const { initAi } = await import('../web/ai.mjs');

let routes = {};
globalThis.fetch = async (path, options = {}) => {
  const route = routes[path] ?? { status: 500, payload: { detail: '未預期的呼叫' } };
  return { ok: route.status < 400, status: route.status, text: async () => JSON.stringify(route.payload) };
};

initAi();

test('a successful write is reported as success, not as an error', async () => {
  routes = {
    '/api/ai/normalize': { status: 200, payload: { text: null } },
    '/api/ai/actions': { status: 200, payload: [] },
    '/api/ai/chat': {
      status: 200,
      payload: {
        answer: '已整理草稿。',
        sources: [],
        drafts: [{
          id: 'd-ok',
          action: 'create_purchase_order',
          title: '建立採購單',
          path: '/api/purchase-orders',
          payload: { po_id: 'PO-900' },
          requires_idempotency: false,
        }],
      },
    },
    '/api/ai/actions/d-ok/confirm': {
      status: 200,
      payload: { po_id: 'PO-900', supplier_name: '台積電', status: '待驗收' },
    },
  };

  el('aiMessage').value = '建立採購單 PO-900';
  await el('aiForm').dispatchEvent({ type: 'submit', preventDefault() {} });

  const card = el('aiLog').children
    .flatMap(entry => entry.children)
    .find(child => child.className === 'chat-draft');
  const [confirmButton] = card.children.filter(child => child.tagName === 'button');
  const result = card.children.at(-1);
  const title = card.children[0];

  // The dashboard refresh after a write must not be reported as a failed submission.
  await confirmButton.click();

  assert.match(result.textContent, /已建立採購單 PO-900/, `實際顯示：${result.textContent}`);
  assert.match(title.textContent, /已完成/);
  assert.equal(el('aiMessage').disabled, false, '寫入成功後應解鎖');
});
