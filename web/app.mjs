import { beginLogin, completeLogin, loadAuthConfig, logout, renderActor } from './auth.mjs';
import { initAi, onAiPanelShown } from './ai.mjs';
import { initOperations, refresh } from './operations.mjs';
import { $, setResult } from './ui.mjs';

function selectWorkspace(ai) {
  $('operationsPanel').hidden = ai;
  $('aiPanel').hidden = !ai;
  for (const [id, selected] of [['aiTab', ai], ['operationsTab', !ai]]) {
    $(id).setAttribute('aria-selected', String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
  if (ai) onAiPanelShown();
}

function bindTabs() {
  $('operationsTab').addEventListener('click', () => selectWorkspace(false));
  $('aiTab').addEventListener('click', () => selectWorkspace(true));
  for (const id of ['operationsTab', 'aiTab']) {
    $(id).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const ai = event.key === 'End' || (event.key !== 'Home' && id === 'operationsTab');
      selectWorkspace(ai);
      $(ai ? 'aiTab' : 'operationsTab').focus();
    });
  }
}

function bindSession() {
  $('loginButton').addEventListener('click', () =>
    beginLogin().catch(error => setResult('authResult', error.message || 'Cognito 登入無法開始。', 'error')),
  );
  $('logoutButton').addEventListener('click', async () => {
    if (!(await logout())) await refresh();
  });
}

async function start() {
  initOperations();
  initAi();
  bindTabs();
  bindSession();
  try {
    const config = await loadAuthConfig();
    $('loginButton').disabled = !config.enabled;
    await completeLogin();
  } catch (error) {
    $('loginButton').disabled = false;
    setResult('authResult', error.message || 'Cognito 設定載入失敗。', 'error');
  }
  renderActor();
  await refresh();
}

start();
