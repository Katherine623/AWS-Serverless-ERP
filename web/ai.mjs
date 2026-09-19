import { api, authErrorMessage } from './api.mjs';
import { session, tokenValue } from './auth.mjs';
import { jobStatusLabel, refresh } from './operations.mjs';
import { $, el, formatDateTime } from './ui.mjs';

const CONFIRMABLE_PATHS = ['/api/purchase-orders', '/api/receipts', '/api/inventory-adjustments'];
const RESOLUTION_PATH = /^\/api\/purchase-orders\/[^/]+\/exception-resolution$/;
const OPEN_ACTION_STATUSES = ['draft', 'failed', 'executing'];

const PAYLOAD_LABELS = {
  po_id: '採購單',
  supplier_name: '供應商',
  expected_date: '預計到貨',
  material_id: '料號',
  material_name: '品名',
  ordered_quantity: '訂購數量',
  received_quantity: '本次實收',
  unit: '單位',
  received_by: '收料人',
  performed_by: '操作者',
  resolved_by: '處置人',
  quantity_change: '異動數量',
  adjustment_type: '異動類型',
  reason: '原因',
  action: '處置方式',
  note: '說明',
};

const aiState = { history: [], busy: false };

function describePayload(payload) {
  return Object.entries(payload)
    .map(([field, value]) =>
      field === 'items'
        ? `品項：\n${value.map((item, index) => `${index + 1}. ${describePayload(item)}`).join('\n')}`
        : `${PAYLOAD_LABELS[field] || field}：${String(value)}`,
    )
    .join('\n');
}

export function resetAiChat() {
  aiState.history = [];
  session.generation += 1;
  $('aiLog').replaceChildren();
  $('aiActions').replaceChildren();
  $('aiStatus').textContent = '';
}

function appendMessage(role, body) {
  const entry = el('div', {
    className: `chat-message ${role}`,
    textContent: `${role === 'user' ? '你' : 'AI 助理'}：\n${body}`,
  });
  $('aiLog').append(entry);
  entry.scrollIntoView({ block: 'nearest' });
  return entry;
}

function showDraft(entry, draft, generation) {
  const title = el('strong', { textContent: `${draft.title} · 待確認` });
  const content = el('pre', { textContent: describePayload(draft.payload) });
  const confirm = el('button', { type: 'button', className: 'button primary', textContent: '確認送出' });
  const cancel = el('button', { type: 'button', className: 'button', textContent: '取消' });
  const result = el('p', {});

  cancel.addEventListener('click', async () => {
    if (generation !== session.generation) return;
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      await api(`/api/ai/actions/${encodeURIComponent(draft.id)}/cancel`, { method: 'POST' });
      if (generation !== session.generation) return;
      result.textContent = '已取消，未送出。';
      loadAiActions().catch(() => {});
    } catch (error) {
      result.textContent = authErrorMessage(error);
      confirm.disabled = false;
      cancel.disabled = false;
    }
  });

  confirm.addEventListener('click', async () => {
    if (generation !== session.generation) return;
    if (!CONFIRMABLE_PATHS.includes(draft.path) && !RESOLUTION_PATH.test(draft.path)) return;
    confirm.disabled = true;
    cancel.disabled = true;
    result.textContent = '正在送出…';
    try {
      const data = await api(`/api/ai/actions/${encodeURIComponent(draft.id)}/confirm`, { method: 'POST' });
      if (generation !== session.generation) return;
      title.textContent = `${draft.title} · 已完成`;
      result.textContent = JSON.stringify(data, null, 2);
      await refresh();
      loadAiActions().catch(() => {});
    } catch (error) {
      if (generation !== session.generation) return;
      result.textContent = authErrorMessage(error);
      // Reuse the same action id so a retry stays idempotent.
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.textContent = '重新送出';
    }
  });

  entry.append(el('div', { className: 'chat-draft' }, title, content, confirm, cancel, result));
}

export async function loadAiActions() {
  const generation = session.generation;
  const actions = await api('/api/ai/actions');
  if (generation !== session.generation) return;
  if (!actions.length) {
    $('aiActions').replaceChildren(el('p', { className: 'help', textContent: '尚無 AI 操作紀錄。' }));
    return;
  }
  $('aiActions').replaceChildren(
    ...actions.map(action => {
      const card = el(
        'details',
        {},
        el('summary', {
          textContent: `${action.preview.title} · ${jobStatusLabel(action.status)} · ${formatDateTime(action.created_at)}`,
        }),
        el('pre', {
          textContent: JSON.stringify(
            {
              操作內容: action.preview.payload,
              歷程: action.events.map(event => `${jobStatusLabel(event.status)} ${formatDateTime(event.at)}`),
              結果: action.result || action.error || '尚無結果',
            },
            null,
            2,
          ),
        }),
      );
      if (OPEN_ACTION_STATUSES.includes(action.status)) {
        showDraft(card, { ...action.preview, id: action.id }, generation);
      }
      return card;
    }),
  );
}

export function onAiPanelShown() {
  if (!tokenValue()) return;
  loadAiActions().catch(error => {
    $('aiActions').replaceChildren(el('p', { className: 'help', textContent: authErrorMessage(error) }));
  });
}

export function initAi() {
  $('aiClear').addEventListener('click', resetAiChat);
  document.addEventListener('erp:signout', resetAiChat);

  for (const button of document.querySelectorAll('.ai-suggestion')) {
    button.addEventListener('click', () => {
      $('aiMessage').value = button.textContent;
      $('aiMessage').focus();
    });
  }

  $('aiForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (aiState.busy) return;
    const message = $('aiMessage').value.trim();
    if (!message) return;
    const generation = session.generation;
    aiState.busy = true;
    $('aiSend').disabled = true;
    $('aiStatus').textContent = '正在查詢與整理資料…';
    appendMessage('user', message);
    $('aiMessage').value = '';
    try {
      const response = await api('/api/ai/chat', {
        method: 'POST',
        body: { message, history: aiState.history.slice(-8) },
      });
      if (generation !== session.generation) return;
      const entry = appendMessage('assistant', response.answer);
      if (response.sources.length) {
        entry.append(
          el(
            'details',
            {},
            el('summary', { textContent: '查看本次查詢來源' }),
            el('pre', { textContent: JSON.stringify(response.sources, null, 2) }),
          ),
        );
      }
      response.drafts.forEach(draft => showDraft(entry, draft, generation));
      if (response.drafts.length) loadAiActions().catch(() => {});
      aiState.history.push(
        { role: 'user', content: message },
        { role: 'assistant', content: response.answer.slice(0, 6000) },
      );
      aiState.history = aiState.history.slice(-8);
      $('aiStatus').textContent = '回答已完成。請核對查詢來源與操作內容。';
    } catch (error) {
      if (generation === session.generation) {
        appendMessage('assistant', authErrorMessage(error));
        $('aiMessage').value = message;
        $('aiStatus').textContent = '未取得回答，可重新送出。';
      }
    } finally {
      aiState.busy = false;
      $('aiSend').disabled = false;
    }
  });
}
