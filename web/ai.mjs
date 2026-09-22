import { api, authErrorMessage } from './api.mjs';
import { session, tokenValue } from './auth.mjs';
import { jobStatusLabel, refresh } from './operations.mjs';
import { $, el, formatDateTime } from './ui.mjs';

const CONFIRMABLE_PATHS = ['/api/purchase-orders', '/api/receipts', '/api/inventory-adjustments'];
const RESOLUTION_PATH = /^\/api\/purchase-orders\/[^/]+\/exception-resolution$/;
const OPEN_ACTION_STATUSES = ['draft', 'failed', 'executing'];
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const PO_VOICE_TEMPLATE = '請幫我建立採購單。採購單編號 PO-，供應商 ，預計到貨日期 ，品項如下：料號 ，品名 ，數量 。最後請先產生草稿，等我確認再送出。';

const VOICE_ERRORS = {
  'no-speech': '沒有聽到聲音，請再說一次。',
  'audio-capture': '找不到麥克風，請確認裝置已連接後重試。',
  'not-allowed': '麥克風權限被拒絕，請在瀏覽器允許麥克風後重試。',
  'service-not-allowed': '瀏覽器不允許使用語音辨識服務，請檢查設定後重試。',
  'language-not-supported': '此瀏覽器不支援中文語音辨識，請改用 Chrome。',
  network: '語音辨識連線失敗，請檢查網路後重試。',
  aborted: '語音輸入已取消。',
};

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
const voiceState = {
  recognition: null,
  listening: false,
  poMode: false,
};

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
  // Also runs on sign-out, so the next user must not inherit a typed question.
  $('aiMessage').value = '';
  $('aiVoiceStatus').textContent = '按下按鈕後直接說出需求，內容會填進上方輸入框。';
}

function setVoiceUi(listening, message) {
  voiceState.listening = listening;
  const buttons = [
    [$('aiVoice'), '語音輸入', !voiceState.poMode],
    [$('aiVoicePoMode'), '語音建立採購單', voiceState.poMode],
  ];
  for (const [button, label, active] of buttons) {
    button.classList.toggle('listening', listening && active);
    button.textContent = listening && active ? '停止語音輸入' : label;
    button.disabled = listening && !active;
  }
  if (message) $('aiVoiceStatus').textContent = message;
}

function submitAiMessage() {
  $('aiForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

function startVoice(recognition, poMode) {
  if (voiceState.listening) {
    recognition.stop();
    return;
  }
  if (aiState.busy) {
    setVoiceUi(false, 'AI 回答中，請稍後再用語音送出。');
    return;
  }
  voiceState.poMode = poMode;
  if (poMode && !$('aiMessage').value.trim()) {
    $('aiMessage').value = PO_VOICE_TEMPLATE;
  }
  try {
    recognition.start();
  } catch {
    setVoiceUi(false, '語音輸入啟動失敗，請稍後重試。');
  }
}

// Mirrors the fields CreatePurchaseOrderRequest requires, so the AI round trip is not wasted.
const PO_VOICE_FIELDS = [
  ['po_id', '採購單編號（例如 PO-20260922）', /\bPO[-\s]?[A-Z0-9-]{2,}\b/i],
  ['supplier', '供應商', /(?:供應商|廠商)\s*[:：]?\s*([^,，。；\n]+)/],
  ['expected_date', '預計到貨日', /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日號]|今天|明天|後天|大後天|下週|下周|這週|本週/],
  ['material_id', '料號', /(?:料號|品號)\s*[:：]?\s*([^\s,，。；\n]+)/],
  ['material_name', '品名', /(?:品名|料件名稱)\s*[:：]?\s*([^,，。；\n]+)/],
  ['quantity', '數量', /(?:數量|訂購)\s*[:：]?\s*(\d+)|(\d+)\s*(?:個|件|支|箱|pcs)/i],
];

function parseVoiceFields(text) {
  const normalized = text.replace(/\s+/g, ' ');
  return Object.fromEntries(
    PO_VOICE_FIELDS.map(([name, , pattern]) => {
      const match = normalized.match(pattern);
      const value = match ? (match[1] ?? match[2] ?? match[0]) : '';
      return [name, String(value).trim()];
    }),
  );
}

function validatePoVoiceText(text) {
  const fields = parseVoiceFields(text);
  const missing = PO_VOICE_FIELDS.filter(([name]) => !fields[name]).map(([, label]) => label);
  return { fields, missing, valid: missing.length === 0 };
}

function browserFallbackMessage() {
  const userAgent = navigator.userAgent || '';
  if (!SpeechRecognition) {
    if (/Edg\//.test(userAgent)) {
      return 'Edge 目前不支援此頁語音辨識，請改用 Chrome，或先在 Edge 語音輸入後貼到文字框。';
    }
    if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) {
      return 'Safari 語音辨識相容性有限，請改用 Chrome，或先用系統語音輸入再貼到文字框。';
    }
    return '目前瀏覽器不支援語音輸入，請改用 Chrome，或先用系統語音輸入後貼到文字框。';
  }
  if (/Edg\//.test(userAgent)) {
    return 'Edge 版本可能出現語音辨識中斷；若失敗請改用 Chrome。';
  }
  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) {
    return 'Safari 可能僅支援部分語音功能；若辨識不穩定請改用 Chrome。';
  }
  return '';
}

function initVoiceInput() {
  const fallback = browserFallbackMessage();
  if (fallback) {
    $('aiVoiceStatus').textContent = fallback;
  }

  if (!SpeechRecognition) {
    $('aiVoice').disabled = true;
    $('aiVoicePoMode').disabled = true;
    $('aiVoiceAutoSend').disabled = true;
    if (!fallback) $('aiVoiceStatus').textContent = '目前瀏覽器不支援語音輸入，請改用文字。';
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-TW';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  voiceState.recognition = recognition;

  recognition.addEventListener('start', () => {
    setVoiceUi(true, '正在聆聽，請直接說出需求。');
  });

  recognition.addEventListener('result', event => {
    let text = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      text += event.results[index][0]?.transcript || '';
    }
    if (!text.trim()) return;
    $('aiMessage').value = text.trim();
    const finalResult = event.results[event.results.length - 1]?.isFinal;
    if (finalResult) {
      if (voiceState.poMode) {
        const check = validatePoVoiceText($('aiMessage').value);
        if (!check.valid) {
          setVoiceUi(false, `辨識完成，但缺少：${check.missing.join('、')}。請補說，或直接按「送出問題」讓 AI 追問。`);
          return;
        }
      }
      setVoiceUi(false, '語音辨識完成，已填入內容。');
      if ($('aiVoiceAutoSend').checked) submitAiMessage();
    } else {
      setVoiceUi(true, '辨識中…已即時填入內容。');
    }
  });

  recognition.addEventListener('end', () => {
    if (voiceState.listening) {
      if (voiceState.poMode) {
        const check = validatePoVoiceText($('aiMessage').value);
        if (!check.valid) {
          setVoiceUi(false, `語音結束，但缺少：${check.missing.join('、')}。請補說，或直接按「送出問題」讓 AI 追問。`);
          return;
        }
      }
      setVoiceUi(false, '語音輸入已結束。');
      if ($('aiVoiceAutoSend').checked && $('aiMessage').value.trim()) submitAiMessage();
    }
  });

  recognition.addEventListener('error', event => {
    setVoiceUi(false, VOICE_ERRORS[event.error] || '語音辨識失敗，請再試一次。');
  });

  $('aiVoicePoMode').addEventListener('click', () => startVoice(recognition, true));
  $('aiVoice').addEventListener('click', () => startVoice(recognition, false));
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
  initVoiceInput();

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
