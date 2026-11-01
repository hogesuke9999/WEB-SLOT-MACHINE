const socket = io();

const sessionForm = document.getElementById('sessionForm');
const childNameInput = document.getElementById('childNameInput');
const sessionIdInput = document.getElementById('sessionIdInput');
const btnJoinSession = document.getElementById('btnJoinSession');
const sessionError = document.getElementById('sessionError');
const slotDisplay = document.getElementById('slotDisplay');
const parentNameBadge = document.getElementById('parentNameBadge');
const audioOverlay = document.getElementById('audioOverlay');

// Web Audio API 合成音生成
class SoundManager {
  constructor() {
    this.ctx = null;
    this.isMuted = true;
    this.spinInterval = null;
  }

  init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.isMuted = false;
  }

  playSpin() {
    if (this.isMuted || !this.ctx) return;
    this.stopSpin();
    this.spinInterval = setInterval(() => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.05, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.05);
    }, 80);
  }

  stopSpin() {
    if (this.spinInterval) clearInterval(this.spinInterval);
  }

  playStop() {
    if (this.isMuted || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(400, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  }

  playWin() {
    if (this.isMuted || !this.ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime + idx * 0.12);
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime + idx * 0.12);
      gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + idx * 0.12 + 0.3);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(this.ctx.currentTime + idx * 0.12);
      osc.stop(this.ctx.currentTime + idx * 0.12 + 0.3);
    });
  }
}

const sound = new SoundManager();

let currentReels = { left: [], center: [], right: [] };
let isSpinning = [false, false, false];
let spinAnimIds = [null, null, null];
let reelOffsets = [0, 0, 0];
let finalResults = ['', '', ''];
let sessionId = null;

function truncateText(text) {
  if (!text) return '';
  return text.length > 8 ? text.slice(0, 8) + '…' : text;
}

function toDisplayItems(reelItems) {
  const items = Array.isArray(reelItems) ? reelItems : [];
  if (items.length === 0) return ['-'];
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && item.text) return item.text;
    return '';
  }).filter((item) => item !== '');
}

function renderReels() {
  const keys = ['left', 'center', 'right'];
  keys.forEach((key, idx) => {
    const strip = document.getElementById(`strip${idx}`);
    if (!strip) return;
    strip.innerHTML = '';
    const items = toDisplayItems(currentReels[key]);
    const displayItems = [...items, ...items, ...items, ...items];
    displayItems.forEach(itemText => {
      const div = document.createElement('div');
      div.className = 'reel-item';
      div.textContent = truncateText(itemText);
      strip.appendChild(div);
    });
  });
}

function setSessionError(message) {
  sessionError.textContent = message;
  sessionError.style.display = 'block';
}

function joinSession() {
  const name = childNameInput.value.trim();
  const id = sessionIdInput.value.trim();
  if (!name || Array.from(name).length > 40) {
    setSessionError('名前を1〜40文字で入力してください');
    return;
  }
  if (!/^\d{4}$/.test(id)) {
    setSessionError('4桁の数字を入力してください');
    return;
  }

  sessionError.style.display = 'none';
  btnJoinSession.disabled = true;
  btnJoinSession.textContent = '承認待ち...';
  socket.emit('C2S_JOIN_SESSION', { sessionId: id, name });
}

btnJoinSession.addEventListener('click', joinSession);
sessionForm.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
    event.preventDefault();
    joinSession();
  }
});

const autoJoined = autoJoinFromUrl();
if (!autoJoined) {
  sessionIdInput.focus();
}

audioOverlay.addEventListener('click', () => {
  sound.init();
  audioOverlay.style.display = 'none';
});

socket.on('S2C_SESSION_ERROR', (data) => {
  setSessionError(data && data.message ? data.message : '接続に失敗しました');
  btnJoinSession.disabled = false;
  btnJoinSession.textContent = '接続をリクエスト';
});

socket.on('S2C_JOIN_PENDING', (data) => {
  sessionError.textContent = data && data.message
    ? data.message
    : '親画面で接続が承認されるまでお待ちください。';
  sessionError.style.display = 'block';
});

socket.on('S2C_JOIN_REJECTED', (data) => {
  setSessionError(data && data.message ? data.message : '接続が拒否されました。');
  btnJoinSession.disabled = false;
  btnJoinSession.textContent = '接続をリクエスト';
});

socket.on('S2C_SESSION_JOINED', (data) => {
  sessionId = data.sessionId;
  sessionForm.style.display = 'none';
  slotDisplay.style.display = 'block';
  sessionError.style.display = 'none';
  parentNameBadge.textContent = data.name ? `親画面: ${data.name}` : '';
  parentNameBadge.hidden = !data.name;
  btnJoinSession.disabled = false;
  btnJoinSession.textContent = '接続をリクエスト';
  if (data && data.reelCount) {
    applyDisplayReelCount(data.reelCount);
  }
  if (currentReels && Object.keys(currentReels).length > 0) {
    renderReels();
  }
});

socket.on('disconnect', () => {
  if (sessionId) {
    sessionId = null;
    slotDisplay.style.display = 'none';
    sessionForm.style.display = 'flex';
    audioOverlay.style.display = 'none';
    parentNameBadge.hidden = true;
    parentNameBadge.textContent = '';
    setSessionError('接続が切れました。もう一度接続してください。');
  } else if (btnJoinSession.disabled) {
    setSessionError('接続が切れました。もう一度お試しください。');
  }
  btnJoinSession.disabled = false;
  btnJoinSession.textContent = '接続をリクエスト';
});

socket.on('S2C_STATE_SYNC', (state) => {
  if (state && state.reels) {
    currentReels = state.reels;
    if (state.reelCount) {
      applyDisplayReelCount(state.reelCount);
    }
    renderReels();
  }
});

socket.on('S2C_SETTINGS_UPDATED', (data) => {
  if (data.reels) {
    currentReels = data.reels;
    if (data.reelCount) {
      applyDisplayReelCount(data.reelCount);
    }
    renderReels();
  }
});

socket.on('S2C_SLOT_STARTED', (data) => {
  document.getElementById('resultModal').classList.remove('show');
  finalResults = data.results;
  isSpinning = [true, true, true];
  sound.playSpin();

  [0, 1, 2].forEach(idx => {
    const strip = document.getElementById(`strip${idx}`);
    if (!strip) return;
    strip.classList.add('spinning');
    animateReel(idx);
  });
});

function animateReel(idx) {
  const strip = document.getElementById(`strip${idx}`);
  if (!strip) return;
  reelOffsets[idx] -= 35;
  if (reelOffsets[idx] <= -1040) {
    reelOffsets[idx] = 0;
  }
  strip.style.transform = `translateY(${reelOffsets[idx]}px)`;
  if (isSpinning[idx]) {
    spinAnimIds[idx] = requestAnimationFrame(() => animateReel(idx));
  }
}

socket.on('S2C_REEL_STOPPED', (data) => {
  const { reelIndex, resultText, isAllStopped } = data;
  isSpinning[reelIndex] = false;
  cancelAnimationFrame(spinAnimIds[reelIndex]);

  const strip = document.getElementById(`strip${reelIndex}`);
  const winEl = document.getElementById(`window${reelIndex}`);
  if (!strip || !winEl) return;

  strip.classList.remove('spinning');
  strip.style.transform = 'translateY(0px)';

  const items = strip.querySelectorAll('.reel-item');
  if (items.length > 0) {
    items[0].textContent = truncateText(resultText);
  }

  winEl.classList.add('flash');
  setTimeout(() => winEl.classList.remove('flash'), 400);
  sound.playStop();

  if (isAllStopped) {
    sound.stopSpin();
    sound.playWin();
    showWinModal();
  }
});

function showWinModal() {
  const modal = document.getElementById('resultModal');
  const resultTextEl = document.getElementById('resultText');
  resultTextEl.textContent = finalResults.map(truncateText).join('  ');

  setTimeout(() => {
    modal.classList.add('show');
    if (typeof confetti === 'function') {
      confetti({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.6 }
      });
    }
  }, 300);
}

function normalizeReelCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 3;
  if (count < 1) return 1;
  if (count > 3) return 3;
  return Math.round(count);
}

function applyDisplayReelCount(count) {
  const reelCount = normalizeReelCount(count);
  const scale = 3 / reelCount;
  document.documentElement.style.setProperty('--reel-scale-x', String(scale));
  for (let i = 0; i < 3; i++) {
    const windowEl = document.getElementById(`window${i}`);
    if (!windowEl) continue;
    windowEl.style.display = i < reelCount ? 'block' : 'none';
  }
}

function getSessionIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('sessionId');
  if (!value) return null;
  const id = String(value).replace(/[^0-9]/g, '').slice(0, 4);
  return /^\d{4}$/.test(id) ? id : null;
}

function autoJoinFromUrl() {
  const id = getSessionIdFromUrl();
  if (!id) return false;
  sessionIdInput.value = id;
  return true;
}