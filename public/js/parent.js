const socket = io();
let registeredSocketId = null;

const sessionRegisterSection = document.getElementById('sessionRegisterSection');
const registerError = document.getElementById('registerError');
const parentNameInput = document.getElementById('parentNameInput');
const btnRegisterParent = document.getElementById('btnRegisterParent');
const sessionInfoBox = document.getElementById('sessionInfoBox');
const sessionIdDisplay = document.getElementById('sessionIdDisplay');
const sessionExpiryText = document.getElementById('sessionExpiryText');
const currentSessionBadge = document.getElementById('currentSessionBadge');

const authSection = document.getElementById('authSection');
const mainSection = document.getElementById('mainSection');
const passwordInput = document.getElementById('passwordInput');
const btnLogin = document.getElementById('btnLogin');
const btnLogout = document.getElementById('btnLogout');
const loginError = document.getElementById('loginError');

const btnStart = document.getElementById('btnStart');
const stopButtonsContainer = document.querySelector('.stop-buttons');
const btnApplySettings = document.getElementById('btnApplySettings');

const childCount = document.getElementById('childCount');
const qrCodeImg = document.getElementById('qrCodeImg');
const childUrlText = document.getElementById('childUrlText');
const joinRequestsList = document.getElementById('joinRequestsList');
const joinRequestsEmpty = document.getElementById('joinRequestsEmpty');
const connectedChildrenList = document.getElementById('connectedChildrenList');
const connectedChildrenEmpty = document.getElementById('connectedChildrenEmpty');

const weightEditor = document.getElementById('weightEditor');
const weightSummary = document.getElementById('weightSummary');

const reelCountInput = document.getElementById('reelCountInput');
const reelInputGroups = Array.from(document.querySelectorAll('.reel-input-group'));
const reelSettingKeys = ['left', 'center', 'right'];

let currentSession = null;
let currentReels = { left: [], center: [], right: [] };
let currentReelCount = 3;
let isSpinning = [false, false, false];
let spinAnimIds = [null, null, null];
let reelOffsets = [0, 0, 0];
let stopButtons = [];

function normalizePercentDistribution(values) {
  const safeValues = Array.isArray(values)
    ? values.map((value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0))))
    : [];

  if (!safeValues.length) return [];
  if (safeValues.length === 1) return [100];

  const total = safeValues.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    const equal = 100 / safeValues.length;
    const distributed = safeValues.map((_, index) => (
      index === safeValues.length - 1 ? 100 - Math.round(equal * (safeValues.length - 1)) : Math.round(equal)
    ));
    const diff = 100 - distributed.reduce((sum, value) => sum + value, 0);
    if (diff !== 0 && distributed.length > 0) {
      distributed[distributed.length - 1] += diff;
    }
    return distributed;
  }

  if (total === 100) return safeValues.slice();

  const adjusted = safeValues.slice();
  adjusted[adjusted.length - 1] = Math.max(0, Math.min(100, adjusted[adjusted.length - 1] + (100 - total)));
  return adjusted;
}

function syncGroupWeightValues(group, rows, sourceValues) {
  const normalized = normalizePercentDistribution(sourceValues);
  rows.forEach((row, index) => {
    const input = row.querySelector('input[type="number"]');
    if (!input) return;
    input.value = String(Math.max(0, Math.min(100, Number(normalized[index]) || 0)));
  });
  updateSliderPointers(group, rows);
  syncWeightSummary();
}

function syncReelSettingPanelsForCount(count) {
  const reelCount = normalizeReelCount(count);

  reelInputGroups.forEach((group, index) => {
    group.style.display = index < reelCount ? 'block' : 'none';
  });

  if (!weightEditor) return;
  const editorGroups = weightEditor.querySelectorAll('[data-reel-key]');
  editorGroups.forEach((group) => {
    const key = group.dataset.reelKey;
    group.style.display = reelSettingKeys.indexOf(key) < reelCount ? 'block' : 'none';
  });
}

reelCountInput.addEventListener('change', () => {
  const count = normalizeReelCount(reelCountInput.value);
  currentReelCount = count;
  reelCountInput.value = String(count);
  syncReelSettingPanelsForCount(count);
  applyReelViewCount(count);
});

function syncReelStateArrays(size) {
  const reelCount = normalizeReelCount(size);
  isSpinning = Array.from({ length: reelCount }, (_, index) => Boolean(isSpinning[index]));
  spinAnimIds = Array.from({ length: reelCount }, (_, index) => spinAnimIds[index] ?? null);
  reelOffsets = Array.from({ length: reelCount }, (_, index) => Number(reelOffsets[index]) || 0);
}

function buildStopButtons(count) {
  if (!stopButtonsContainer) return;

  const reelCount = normalizeReelCount(count);
  syncReelStateArrays(reelCount);
  stopButtonsContainer.innerHTML = '';
  stopButtons = [];

  for (let index = 0; index < reelCount; index += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-stop';
    button.textContent = `${laneLabel(index)} ストップ`;
    button.disabled = Boolean(isSpinning[index]);

    button.addEventListener('click', () => {
      if (!currentSession) return;
      socket.emit('C2S_STOP_REEL', {
        sessionId: currentSession.sessionId,
        sessionToken: currentSession.token,
        reelIndex: index
      });
    });

    stopButtons.push(button);
    stopButtonsContainer.appendChild(button);
  }
}

function normalizeReelCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 3;
  if (count < 1) return 1;
  if (count > 3) return 3;
  return Math.round(count);
}

function laneLabel(index) {
  return `${index + 1}つ目`;
}

function updateReelControlsForCount(count) {
  const reelCount = normalizeReelCount(count);
  buildStopButtons(reelCount);
  stopButtons.forEach((button, index) => {
    button.disabled = index >= reelCount || Boolean(isSpinning[index]);
  });
}

function applyReelScale(count) {
  const reelCount = normalizeReelCount(count);
  const root = document.documentElement;

  if (reelCount === 3) {
    root.style.setProperty('--reel-scale-x', '1');
    root.style.setProperty('--stop-scale-x', '1');
  } else if (reelCount === 2) {
    root.style.setProperty('--reel-scale-x', '1.5');
    root.style.setProperty('--stop-scale-x', '1.5');
  } else {
    root.style.setProperty('--reel-scale-x', '3');
    root.style.setProperty('--stop-scale-x', '3');
  }
}

function applyReelViewCount(count) {
  currentReelCount = normalizeReelCount(count);
  reelCountInput.value = String(currentReelCount);
  syncReelStateArrays(currentReelCount);
  syncReelSettingPanelsForCount(currentReelCount);
  applyReelScale(currentReelCount);
  for (let i = 0; i < 3; i++) {
    const strip = document.getElementById(`strip${i}`);
    const windowEl = document.getElementById(`window${i}`);
    if (!strip || !windowEl) continue;
    const visible = i < currentReelCount;
    strip.style.display = visible ? 'flex' : 'none';
    windowEl.style.display = visible ? 'block' : 'none';
  }
  document.querySelectorAll('[data-reel-index]').forEach((element) => {
    element.hidden = Number(element.dataset.reelIndex) >= currentReelCount;
  });
  updateReelControlsForCount(currentReelCount);
}

checkParentSession();

function showRegister() {
  sessionRegisterSection.style.display = 'block';
  authSection.style.display = 'none';
  mainSection.style.display = 'none';
  btnLogout.style.display = 'none';
  currentSessionBadge.style.display = 'none';
}

function showMain() {
  sessionRegisterSection.style.display = 'none';
  authSection.style.display = 'none';
  mainSection.style.display = 'block';
  btnLogout.style.display = 'inline-block';
  if (currentSession) {
    currentSessionBadge.textContent = `親: ${currentSession.name || '親'} / ID: ${currentSession.sessionId}`;
    currentSessionBadge.style.display = 'inline-block';
  }
  loadQR();
  loadHistory();
}

function registerParentSocket() {
  if (!currentSession || !socket.connected || registeredSocketId === socket.id) return;
  registeredSocketId = socket.id;
  socket.emit('C2S_REGISTER_PARENT_CONNECT', {
    sessionId: currentSession.sessionId,
    sessionToken: currentSession.token
  });
}

socket.on('connect', () => {
  registeredSocketId = null;
  registerParentSocket();
});

socket.on('disconnect', () => {
  registeredSocketId = null;
});

function formatExpiry(dateMs) {
  if (!dateMs) return '期限不明';
  return new Date(dateMs).toLocaleString('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

async function checkParentSession() {
  try {
    const res = await fetch('/api/check-parent-session');
    const data = await res.json();
    if (data.registered) {
      currentSession = {
        sessionId: data.sessionId,
        name: data.name,
        token: data.token,
        expiresAt: data.expiresAt
      };
      sessionRegisterSection.style.display = 'none';
      sessionInfoBox.style.display = 'block';
      sessionIdDisplay.textContent = data.sessionId;
      sessionExpiryText.textContent = `有効期限: ${formatExpiry(data.expiresAt)}`;
      registerParentSocket();
      showMain();
      return;
    }
  } catch (error) {
    console.error(error);
  }

  showRegister();
}

btnRegisterParent.addEventListener('click', async () => {
  registerError.style.display = 'none';
  const name = parentNameInput.value.trim();
  const reelCount = normalizeReelCount(reelCountInput.value);

  try {
    const res = await fetch('/api/register-parent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, reelCount })
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      registerError.textContent = data.message || '登録に失敗しました';
      registerError.style.display = 'block';
      return;
    }

    currentSession = {
      sessionId: data.sessionId,
      name: data.name,
      token: data.token,
      expiresAt: data.expiresAt,
      reelCount: data.reelCount
    };

    currentReelCount = normalizeReelCount(data.reelCount || 3);
    applyReelViewCount(currentReelCount);
    sessionIdDisplay.textContent = data.sessionId;
    sessionExpiryText.textContent = `有効期限: ${formatExpiry(data.expiresAt)}`;
    sessionInfoBox.style.display = 'block';
    registerParentSocket();
    showMain();
  } catch (error) {
    registerError.textContent = '通信エラーが発生しました';
    registerError.style.display = 'block';
  }
});

socket.on('S2C_SESSION_READY', (data) => {
  if (data && data.reelCount) {
    currentReelCount = normalizeReelCount(data.reelCount);
    applyReelViewCount(currentReelCount);
  }
  if (joinRequestsList) {
    joinRequestsList.replaceChildren();
    (data.pendingJoinRequests || []).forEach(addJoinRequest);
    updateJoinRequestsEmptyState();
  }
  renderConnectedChildren(data.connectedChildren || []);
  loadHistory();
});

socket.on('S2C_JOIN_REQUEST', addJoinRequest);

socket.on('S2C_JOIN_REQUEST_REMOVED', ({ requestId }) => {
  const item = Array.from(joinRequestsList.children)
    .find((element) => element.dataset.requestId === requestId);
  if (item) item.remove();
  updateJoinRequestsEmptyState();
});

function updateJoinRequestsEmptyState() {
  if (joinRequestsEmpty && joinRequestsList) {
    joinRequestsEmpty.style.display = joinRequestsList.children.length ? 'none' : 'block';
  }
}

function renderConnectedChildren(children) {
  if (!connectedChildrenList) return;
  connectedChildrenList.replaceChildren();
  (Array.isArray(children) ? children : []).forEach((childName) => {
    if (typeof childName !== 'string') return;
    const item = document.createElement('li');
    item.className = 'connected-child';
    item.textContent = childName;
    connectedChildrenList.appendChild(item);
  });
  if (connectedChildrenEmpty) {
    connectedChildrenEmpty.style.display = connectedChildrenList.children.length ? 'none' : 'block';
  }
}

function addJoinRequest(request) {
  if (!joinRequestsList || !request || !request.requestId || !request.name) return;
  const exists = Array.from(joinRequestsList.children)
    .some((item) => item.dataset.requestId === request.requestId);
  if (exists) return;

  const item = document.createElement('li');
  item.className = 'join-request';
  item.dataset.requestId = request.requestId;

  const name = document.createElement('span');
  name.className = 'join-request-name';
  name.textContent = request.name;

  const actions = document.createElement('div');
  actions.className = 'join-request-actions';
  const approveButton = document.createElement('button');
  approveButton.type = 'button';
  approveButton.className = 'join-request-approve';
  approveButton.textContent = '接続を承認';
  approveButton.addEventListener('click', () => {
    socket.emit('C2S_APPROVE_JOIN', { requestId: request.requestId });
  });

  const rejectButton = document.createElement('button');
  rejectButton.type = 'button';
  rejectButton.className = 'join-request-reject';
  rejectButton.textContent = '拒否';
  rejectButton.addEventListener('click', () => {
    socket.emit('C2S_REJECT_JOIN', { requestId: request.requestId });
  });

  actions.append(approveButton, rejectButton);
  item.append(name, actions);
  joinRequestsList.appendChild(item);
  updateJoinRequestsEmptyState();
}

socket.on('S2C_SESSION_JOINED', (data) => {
  if (data && data.reelCount) {
    currentReelCount = normalizeReelCount(data.reelCount);
    applyReelViewCount(currentReelCount);
  }
});

socket.on('S2C_STATE_SYNC', (state) => {
  if (state && state.reelCount) {
    currentReelCount = normalizeReelCount(state.reelCount);
    applyReelViewCount(currentReelCount);
  }
});

btnLogin.addEventListener('click', async () => {
  const password = passwordInput.value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (data.success) {
    showMain();
  } else {
    loginError.textContent = data.message;
    loginError.style.display = 'block';
  }
});

btnLogout.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  currentSession = null;
  showRegister();
});

async function loadQR() {
  if (!currentSession) return;
  const res = await fetch('/api/qrcode');
  const data = await res.json();
  if (!res.ok || !data) return;
  qrCodeImg.src = data.qr;
  childUrlText.textContent = data.url;
}

function truncateText(text) {
  if (!text) return '';
  return text.length > 8 ? text.slice(0, 8) + '…' : text;
}

function reelItemsToTextList(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return ['-'];
  return list.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && item.text) return item.text;
    return '';
  }).filter((item) => item !== '');
}

function renderPreviewReels() {
  const keys = ['left', 'center', 'right'];
  keys.forEach((key, idx) => {
    const strip = document.getElementById(`strip${idx}`);
    if (!strip) return;
    strip.innerHTML = '';
    const items = reelItemsToTextList(currentReels[key]);
    const displayItems = [...items, ...items, ...items, ...items];
    displayItems.forEach(itemText => {
      const div = document.createElement('div');
      div.className = 'preview-reel-item';
      div.textContent = truncateText(itemText);
      strip.appendChild(div);
    });
  });
}

socket.on('S2C_SESSION_ERROR', (data) => {
  if (data && data.message) {
    alert(data.message);
  }
});

socket.on('S2C_CLIENT_COUNT', (data) => {
  childCount.textContent = `接続端末: ${data.count}台`;
  renderConnectedChildren(data.children || []);
});

socket.on('S2C_SETTINGS_UPDATED', (data) => {
  if (data.reels) {
    currentReels = normalizeReelsForSave(data.reels);
    renderSettings(currentReels);
  }
});

function buildSettingsSummary(reels) {
  const activeKeys = reelSettingKeys.slice(0, currentReelCount || normalizeReelCount(reelCountInput.value));
  const lines = ['設定を適用しました。\n\n変更内容:'];

  activeKeys.forEach((key, index) => {
    const entries = Array.isArray(reels && reels[key]) ? reels[key] : [];
    if (!entries.length) return;

    const summary = entries.map((entry) => {
      const text = entry && entry.text ? String(entry.text) : '項目なし';
      const value = Number(entry && entry.weight) || 0;
      return `${text}: ${value}%`;
    }).join(' / ');

    lines.push(`${laneLabel(index)}のレーン: ${summary}`);
  });

  return lines.join('\n');
}

btnApplySettings.addEventListener('click', () => {
  if (!currentSession) {
    alert('セッションが登録されていません');
    return;
  }

  const reels = normalizeReelsForSave(readWeightEditorReels());
  const activeKeys = reelSettingKeys.slice(0, currentReelCount);
  const hasInvalid = activeKeys.some((key) => {
    const total = (reels[key] || []).reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
    return total !== 100;
  });

  if (hasInvalid) {
    alert('各リールの比率の合計が100%になるように調整してください。');
    return;
  }

  const summary = buildSettingsSummary(reels);
  socket.emit('C2S_UPDATE_SETTINGS', {
    sessionId: currentSession.sessionId,
    sessionToken: currentSession.token,
    reels: {
      left: reels.left,
      center: reels.center,
      right: reels.right
    }
  });
  alert(summary);
});

btnStart.addEventListener('click', () => {
  if (!currentSession) return;
  socket.emit('C2S_START_SLOT', {
    sessionId: currentSession.sessionId,
    sessionToken: currentSession.token
  });
});

socket.on('S2C_SLOT_STARTED', () => {
  btnStart.disabled = true;
  btnApplySettings.disabled = true;

  isSpinning = Array.from({ length: currentReelCount }, () => true);
  stopButtons.forEach((button, index) => {
    button.disabled = index >= currentReelCount;
    if (index < currentReelCount) button.disabled = false;
  });
  [0, 1, 2].forEach(idx => {
    const strip = document.getElementById(`strip${idx}`);
    if (!strip) return;
    strip.classList.add('spinning');
    animatePreviewReel(idx);
  });
});

function animatePreviewReel(idx) {
  const strip = document.getElementById(`strip${idx}`);
  if (!strip) return;
  reelOffsets[idx] -= 25;
  if (reelOffsets[idx] <= -640) {
    reelOffsets[idx] = 0;
  }
  strip.style.transform = `translateY(${reelOffsets[idx]}px)`;
  if (isSpinning[idx]) {
    spinAnimIds[idx] = requestAnimationFrame(() => animatePreviewReel(idx));
  }
}

socket.on('S2C_REEL_STOPPED', (data) => {
  const stopButton = stopButtons[data.reelIndex];
  if (stopButton) stopButton.disabled = true;

  const { reelIndex, resultText, isAllStopped } = data;
  isSpinning[reelIndex] = false;
  cancelAnimationFrame(spinAnimIds[reelIndex]);

  const strip = document.getElementById(`strip${reelIndex}`);
  const winEl = document.getElementById(`window${reelIndex}`);
  if (!strip || !winEl) return;

  strip.classList.remove('spinning');
  strip.style.transform = 'translateY(0px)';

  const items = strip.querySelectorAll('.preview-reel-item');
  if (items.length > 0) {
    items[0].textContent = truncateText(resultText);
  }

  winEl.classList.add('flash');
  setTimeout(() => winEl.classList.remove('flash'), 400);

  if (isAllStopped) {
    btnStart.disabled = false;
    btnApplySettings.disabled = false;
    loadHistory();
  }
});

function parseReelData(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries
    .map((item) => {
      if (typeof item === 'string') {
        return { text: item.trim(), weight: 0 };
      }
      if (!item || typeof item !== 'object') {
        return null;
      }
      const text = String(item.text ?? item.label ?? item.value ?? '').trim();
      return { text, weight: Number(item.weight ?? item.percentage ?? 0) || 0 };
    })
    .filter((item) => item && item.text);
}

function normalizeWidgetReel(entries) {
  const items = parseReelData(entries);
  if (items.length === 0) return [];

  const total = items.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
  if (total <= 0) {
    const equal = 100 / items.length;
    return items.map((item, idx) => ({
      text: item.text,
      weight: idx === items.length - 1 ? 100 - (equal * (items.length - 1)) : equal
    }));
  }

  const ratio = items.map((item) => ({
    text: item.text,
    weight: Math.round(((Number(item.weight) || 0) / total) * 100)
  }));
  const diff = 100 - ratio.reduce((sum, item) => sum + item.weight, 0);
  if (diff !== 0 && ratio.length > 0) ratio[0].weight += diff;
  return ratio;
}

function readWeightEditorReels() {
  const result = { left: [], center: [], right: [] };
  if (!weightEditor) return result;

  const groups = Array.from(weightEditor.querySelectorAll('[data-reel-key]'));
  groups.forEach((group) => {
    const key = group.dataset.reelKey;
    if (!key || !result[key]) return;

    const rows = Array.from(group.querySelectorAll('.weight-row'));
    result[key] = rows.map((row) => {
      const textInput = row.querySelector('input[type="text"]');
      const numberInput = row.querySelector('input[type="number"]');
      const text = textInput ? textInput.value.trim() : '';
      const rawWeight = Number(numberInput && numberInput.value !== '' ? numberInput.value : 0);
      const weight = Number.isFinite(rawWeight) ? Math.max(0, Math.min(100, rawWeight)) : 0;
      return { text, weight };
    }).filter((item) => item.text || item.weight > 0);
  });

  return result;
}

function normalizeReelsForSave(reels) {
  const normalized = { left: [], center: [], right: [] };
  ['left', 'center', 'right'].forEach((key) => {
    normalized[key] = normalizeWidgetReel(reels && reels[key]);
  });
  return normalized;
}

async function loadHistory() {
  const res = await fetch('/api/history');
  if (!res.ok) return;
  const data = await res.json();
  historyTableBody.replaceChildren();
  data.forEach((h) => {
    const tr = document.createElement('tr');
    const values = [
      new Date(h.executed_at).toLocaleString(),
      h.result_left,
      h.result_center,
      h.result_right
    ];
    values.slice(0, currentReelCount + 1).forEach((value, index) => {
      const cell = document.createElement('td');
      if (index > 0) cell.dataset.reelIndex = String(index - 1);
      cell.textContent = value;
      tr.appendChild(cell);
    });
    historyTableBody.appendChild(tr);
  });
}

function syncWeightSummary() {
  if (!weightSummary) return;
  weightSummary.style.display = 'none';
  weightSummary.textContent = '';
}

function renderSettings(reels) {
  currentReels = reels;
  buildWeightEditorFromReels(reels);
  syncReelSettingPanelsForCount(currentReelCount);
  renderPreviewReels();
}

function updateSliderPointers(group, rows) {
  const pointerEls = Array.from(group.querySelectorAll('.reel-slider-pointer'));
  if (!pointerEls.length) return;

  const values = rows.map((row) => Number(row.querySelector('input[type="number"]')?.value || 0));
  const normalizedValues = normalizePercentDistribution(values);
  const boundaries = getReelBoundariesFromWeights(normalizedValues);

  pointerEls.forEach((pointer, index) => {
    const position = index < boundaries.length ? boundaries[index] : 100;
    pointer.style.left = `${Math.round(position)}%`;
    pointer.setAttribute('title', `${Math.round(position)}%`);
  });
}

function buildWeightEditorFromReels(reels) {
  if (!weightEditor) return;
  weightEditor.innerHTML = '';

  const activeKeys = reelSettingKeys.slice(0, currentReelCount || normalizeReelCount(reelCountInput.value));
  const keys = ['left', 'center', 'right'];

  const rebuildSliderForGroup = (group, rows) => {
    const existing = group.querySelector('.reel-slider-wrap');
    if (existing) existing.remove();
    createSliderForGroup(group, rows);
  };

  const createSliderForGroup = (group, rows) => {
    const wrap = document.createElement('div');
    wrap.className = 'reel-slider-wrap';

    const track = document.createElement('div');
    track.className = 'reel-slider-track';

    const startDragging = (event, index) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const currentValues = rows.map((row) => Number(row.querySelector('input[type="number"]')?.value || 0));
      const normalizedValues = normalizePercentDistribution(currentValues);
      const boundaries = getReelBoundariesFromWeights(normalizedValues);
      const prevBoundary = index === 0 ? 0 : boundaries[index - 1];
      const nextBoundary = index === boundaries.length - 1 ? 100 : boundaries[index + 1];

      const movePointer = (moveEvent) => {
        const rect = track.getBoundingClientRect();
        const x = Math.min(Math.max(moveEvent.clientX - rect.left, 0), rect.width);
        const targetPosition = Math.min(Math.max((x / rect.width) * 100, prevBoundary), nextBoundary);
        const nextBoundaries = boundaries.slice();
        nextBoundaries[index] = targetPosition;
        const nextValues = getWeightsFromBoundaries(nextBoundaries, rows.length);
        syncGroupWeightValues(group, rows, nextValues);
      };

      const stopDragging = () => {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', movePointer);
        window.removeEventListener('mouseup', stopDragging);
      };

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      movePointer(event);
      window.addEventListener('mousemove', movePointer);
      window.addEventListener('mouseup', stopDragging, { once: true });
    };

    for (let index = 0; index < Math.max(0, rows.length - 1); index += 1) {
      const pointer = document.createElement('button');
      pointer.type = 'button';
      pointer.className = 'reel-slider-pointer';
      pointer.textContent = '＋';
      pointer.dataset.pointerIndex = String(index);
      track.appendChild(pointer);
    }

    track.addEventListener('mousedown', (event) => {
      const pointer = event.target.closest('.reel-slider-pointer');
      if (!pointer) return;
      const index = Number(pointer.dataset.pointerIndex);
      if (Number.isNaN(index)) return;
      startDragging(event, index);
    });

    wrap.appendChild(track);
    group.appendChild(wrap);
    updateSliderPointers(group, rows);
  };

  const createValueRow = (keyName, entry, idx, group, itemCount) => {
    const row = document.createElement('div');
    row.className = 'weight-row';
    row.dataset.key = keyName;
    row.dataset.index = String(idx);
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.marginBottom = '6px';

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = entry.text || '';
    textInput.dataset.key = keyName;
    textInput.dataset.index = String(idx);
    textInput.style.flex = '1';
    textInput.style.minWidth = '0';
    textInput.placeholder = '項目名';

    const numberInput = document.createElement('input');
    numberInput.type = 'number';
    numberInput.min = '0';
    numberInput.max = '100';
    numberInput.step = '1';
    numberInput.value = String(Math.max(0, Math.min(100, Number(entry.weight) || 0)));
    numberInput.dataset.key = keyName;
    numberInput.dataset.index = String(idx);
    numberInput.style.width = '72px';
    numberInput.placeholder = '％';

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = '削除';
    removeButton.style.padding = '4px 6px';
    removeButton.style.color = '#000';
    removeButton.disabled = itemCount <= 1;

    removeButton.addEventListener('click', () => {
      if (itemCount <= 1) return;
      const rows = Array.from(group.querySelectorAll('.weight-row'));
      const removeIndex = rows.indexOf(row);
      if (removeIndex >= 0) {
        row.remove();
        const remainingRows = Array.from(group.querySelectorAll('.weight-row'));
        if (!remainingRows.length) return;

        const values = remainingRows.map((currentRow) => Number(currentRow.querySelector('input[type="number"]')?.value || 0));
        const normalizedValues = normalizePercentDistribution(values);
        remainingRows.forEach((currentRow, index) => {
          const input = currentRow.querySelector('input[type="number"]');
          if (input) input.value = String(Math.max(0, Math.min(100, Number(normalizedValues[index]) || 0)));
        });
      }
      rebuildSliderForGroup(group, Array.from(group.querySelectorAll('.weight-row')));
      syncWeightSummary();
    });

    const applyCurrentValue = () => {
      const rowIndex = Number(row.dataset.index);
      const valueToApply = Number(numberInput.value) || 0;
      applyPercentDistributionToReel(keyName, rowIndex, valueToApply);
      updateSliderPointers(group, Array.from(group.querySelectorAll('.weight-row')));
    };

    textInput.addEventListener('input', () => {
      if (textInput.value.trim()) {
        applyCurrentValue();
      }
    });
    numberInput.addEventListener('input', applyCurrentValue);

    row.appendChild(textInput);
    row.appendChild(numberInput);
    row.appendChild(removeButton);
    group.appendChild(row);
    return row;
  };

  keys.forEach((key) => {
    const items = parseReelData(reels[key]);
    const group = document.createElement('div');
    group.dataset.reelKey = key;
    group.style.marginBottom = '12px';
    group.style.padding = '8px';
    group.style.background = '#1d1d1d';
    group.style.borderRadius = '6px';
    group.style.display = activeKeys.includes(key) ? 'block' : 'none';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.marginBottom = '8px';

    const title = document.createElement('div');
    title.textContent = `${laneLabel(reelSettingKeys.indexOf(key))}のレーン`;

    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = '+ 追加';
    addButton.style.padding = '4px 8px';
    addButton.style.color = '#000';

    header.appendChild(title);
    header.appendChild(addButton);
    group.appendChild(header);

    const entries = items.length > 0 ? items : [{ text: '', weight: 100 }];
    const rows = [];
    entries.forEach((entry, idx) => {
      const row = createValueRow(key, entry, idx, group, entries.length);
      rows.push(row);
    });

    addButton.addEventListener('click', () => {
      const newIndex = rows.length;
      const newEntry = { text: '', weight: 0 };
      const newRow = createValueRow(key, newEntry, newIndex, group, rows.length + 1);
      rows.push(newRow);

      const allRows = Array.from(group.querySelectorAll('.weight-row'));
      const values = allRows.map((row) => Number(row.querySelector('input[type="number"]')?.value || 0));
      const normalizedValues = normalizePercentDistribution(values);
      allRows.forEach((row, index) => {
        const input = row.querySelector('input[type="number"]');
        if (input) input.value = String(Math.max(0, Math.min(100, Number(normalizedValues[index]) || 0)));
      });

      rebuildSliderForGroup(group, allRows);
      syncWeightSummary();
    });

    rebuildSliderForGroup(group, rows);
    weightEditor.appendChild(group);
  });

  syncWeightSummary();
}

function applyPercentDistributionToReel(key, changedIndex, changedValue) {
  const group = weightEditor?.querySelector(`div[data-reel-key="${key}"]`);
  if (!group) return;

  const rows = Array.from(group.querySelectorAll('.weight-row'));
  if (!rows.length) return;

  const index = Number(changedIndex);
  const targetValue = Math.max(0, Math.min(100, Number(changedValue) || 0));
  const currentValues = rows.map((row) => Number(row.querySelector('input[type="number"]')?.value || 0));
  const nextValues = currentValues.slice();
  nextValues[index] = targetValue;

  if (rows.length === 1) {
    nextValues[0] = 100;
  } else {
    const otherIndices = rows
      .map((_, rowIndex) => rowIndex)
      .filter((rowIndex) => rowIndex !== index);
    const otherTotal = otherIndices.reduce((sum, rowIndex) => sum + currentValues[rowIndex], 0);

    if (otherTotal === 0) {
      const remaining = 100 - targetValue;
      const base = Math.floor(remaining / otherIndices.length);
      const extra = remaining % otherIndices.length;
      otherIndices.forEach((rowIndex, offset) => {
        nextValues[rowIndex] = base + (offset < extra ? 1 : 0);
      });
    } else {
      const remaining = 100 - targetValue;
      const ratio = remaining / otherTotal;
      otherIndices.forEach((rowIndex) => {
        nextValues[rowIndex] = Math.round(currentValues[rowIndex] * ratio);
      });

      let diff = 100 - targetValue - otherIndices.reduce((sum, rowIndex) => sum + nextValues[rowIndex], 0);
      if (diff !== 0 && otherIndices.length > 0) {
        const mostWeightedIndex = otherIndices.reduce((bestIndex, rowIndex) => (
          currentValues[rowIndex] > currentValues[bestIndex] ? rowIndex : bestIndex
        ), otherIndices[0]);
        nextValues[mostWeightedIndex] += diff;
      }
    }
  }

  const normalizedValues = normalizePercentDistribution(nextValues);
  rows.forEach((row, rowIndex) => {
    const value = Math.max(0, Math.min(100, Number(normalizedValues[rowIndex]) || 0));
    const numberInput = row.querySelector('input[type="number"]');
    if (numberInput) numberInput.value = String(value);
  });

  updateSliderPointers(group, rows);
  syncWeightSummary();
}

function getReelBoundariesFromWeights(values) {
  const safeValues = Array.isArray(values)
    ? values.map((value) => Math.max(0, Math.round(Number(value) || 0)))
    : [];
  if (!safeValues.length) return [];

  let cumulative = 0;
  return safeValues.slice(0, -1).map((value) => {
    cumulative += Number(value) || 0;
    return Math.max(0, Math.min(100, Math.round(cumulative)));
  });
}

function getWeightsFromBoundaries(boundaries, itemCount) {
  const safeItemCount = Math.max(1, Number(itemCount) || 1);
  const safeBoundaries = Array.isArray(boundaries)
    ? boundaries.map((value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0))))
    : [];

  if (safeItemCount === 1) return [100];

  const weights = [];
  for (let index = 0; index < safeItemCount; index += 1) {
    if (index === 0) {
      weights.push(safeBoundaries[0] ?? 0);
    } else if (index === safeItemCount - 1) {
      weights.push(Math.max(0, 100 - (safeBoundaries[safeItemCount - 2] ?? 0)));
    } else {
      const previous = safeBoundaries[index - 1] ?? 0;
      const current = safeBoundaries[index] ?? previous;
      weights.push(Math.max(0, current - previous));
    }
  }

  const roundedWeights = weights.map((value) => Math.round(value));
  const total = roundedWeights.reduce((sum, value) => sum + value, 0);
  if (total > 0 && total !== 100) {
    roundedWeights[roundedWeights.length - 1] += 100 - total;
  }

  return roundedWeights.map((value) => Math.max(0, Math.min(100, value)));
}

socket.on('S2C_SETTINGS_UPDATED', (data) => {
  if (data.reels) {
    currentReels = normalizeReelsForSave(data.reels);
    renderSettings(currentReels);
  }
});

function initializeParentUi() {
  renderSettings({
    left: [
      { text: '大吉', weight: 25 },
      { text: '中吉', weight: 50 },
      { text: '小吉', weight: 25 }
    ],
    center: [
      { text: '1等', weight: 40 },
      { text: '2等', weight: 35 },
      { text: '3等', weight: 15 },
      { text: '参加賞', weight: 10 }
    ],
    right: [
      { text: '100pt', weight: 25 },
      { text: '50pt', weight: 25 },
      { text: '10pt', weight: 30 },
      { text: '0pt', weight: 20 }
    ]
  });
  applyReelViewCount(3);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeParentUi, { once: true });
} else {
  initializeParentUi();
}