const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_TOKEN = 'VALID_ADMIN_SESSION_TOKEN_999';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REELS = {
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
};

const MIN_REEL_COUNT = 1;
const MAX_REEL_COUNT = 3;
const JOIN_REQUEST_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_JOIN_REQUESTS = 20;
const JOIN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_JOIN_ATTEMPTS_PER_WINDOW = 10;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
  if (err) console.error('DB Connection Error:', err);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      result_left TEXT NOT NULL,
      result_center TEXT NOT NULL,
      result_right TEXT NOT NULL,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

const sessionStore = new Map();
const joinAttemptsByIp = new Map();

function normalizeReelCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 3;
  if (count < MIN_REEL_COUNT) return MIN_REEL_COUNT;
  if (count > MAX_REEL_COUNT) return MAX_REEL_COUNT;
  return Math.round(count);
}

function createSessionState(reelCount = 3) {
  const normalizedCount = normalizeReelCount(reelCount);
  return {
    reels: normalizeReelState(DEFAULT_REELS),
    reelCount: normalizedCount,
    status: 'IDLE',
    spinningReels: Array.from({ length: normalizedCount }, () => false),
    currentResults: Array.from({ length: normalizedCount }, () => null),
    forcedResults: Array.from({ length: normalizedCount }, () => null)
  };
}

function getReelTextList(reelEntries) {
  return normalizeReelEntries(reelEntries).map((item) => item.text);
}

function getReelValueByIndex(reelEntries, index) {
  const entries = normalizeReelEntries(reelEntries);
  if (!entries[index]) return '';
  return entries[index].text;
}

function sessionRoomName(sessionId) {
  return `session:${String(sessionId)}`;
}

function parentRoomName(sessionId) {
  return `${sessionRoomName(sessionId)}:parents`;
}

function generateSessionId() {
  let id = String(crypto.randomInt(1000, 10000));
  while (sessionStore.has(id)) {
    id = String(crypto.randomInt(1000, 10000));
  }
  return id;
}

function getSessionById(sessionId) {
  if (!sessionId) return null;
  const safeId = String(sessionId);
  const session = sessionStore.get(safeId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    closeSession(session, '親セッションの有効期限が切れました。');
    return null;
  }
  return session;
}

function createSessionRecord(name = '親', reelCount = 3) {
  const sessionId = generateSessionId();
  const normalizedCount = normalizeReelCount(reelCount);
  const session = {
    id: sessionId,
    name: String(name || '親').trim() || '親',
    token: crypto.randomBytes(32).toString('hex'),
    expiresAt: Date.now() + SESSION_TTL_MS,
    state: createSessionState(normalizedCount),
    pendingJoinRequests: new Map(),
    parentSockets: new Set(),
    childSockets: new Set()
  };
  sessionStore.set(sessionId, session);
  return session;
}

function closeSession(session, message) {
  if (!session || sessionStore.get(session.id) !== session) return;
  sessionStore.delete(session.id);
  for (const request of session.pendingJoinRequests.values()) {
    removeJoinRequest(session, request, message);
  }
  for (const socket of session.parentSockets) socket.disconnect(true);
  for (const socket of session.childSockets) socket.disconnect(true);
}

function getParentSessionFromRequest(req) {
  const sessionId = req.cookies && req.cookies.parent_session_id;
  const token = req.cookies && req.cookies.parent_session_token;
  const session = getSessionById(sessionId);
  if (!session || session.token !== token) return null;
  return session;
}

function isAdminAuthenticated(req) {
  return req.cookies && req.cookies.admin_token === SESSION_TOKEN;
}

function isParentSessionAuthenticated(req) {
  return Boolean(getParentSessionFromRequest(req));
}

function getSessionAuth(data) {
  if (!data || !data.sessionId || !data.sessionToken) return null;
  const session = getSessionById(data.sessionId);
  if (!session || session.token !== data.sessionToken) return null;
  return session;
}

function emitRoomCount(sessionId) {
  const session = getSessionById(sessionId);
  const children = session
    ? Array.from(session.childSockets, (childSocket) => childSocket.data.childName || '名前未設定')
    : [];
  io.to(parentRoomName(sessionId)).emit('S2C_CLIENT_COUNT', {
    count: children.length,
    children
  });
}

function isJoinRateLimited(ipAddress) {
  const now = Date.now();
  let attempts = joinAttemptsByIp.get(ipAddress);
  if (!attempts || now - attempts.startedAt >= JOIN_RATE_LIMIT_WINDOW_MS) {
    attempts = { startedAt: now, count: 0 };
    joinAttemptsByIp.set(ipAddress, attempts);
  }
  attempts.count += 1;
  return attempts.count > MAX_JOIN_ATTEMPTS_PER_WINDOW;
}

function removeJoinRequest(session, request, message) {
  if (!session.pendingJoinRequests.delete(request.id)) return;
  clearTimeout(request.timeout);
  request.socket.data.pendingJoinRequest = null;
  request.socket.data.role = null;
  request.socket.data.sessionId = null;
  if (message && request.socket.connected) {
    request.socket.emit('S2C_JOIN_REJECTED', { message });
  }
  io.to(parentRoomName(session.id)).emit('S2C_JOIN_REQUEST_REMOVED', {
    requestId: request.id
  });
}

function getParentSocketSession(socket, data) {
  if (!socket || socket.data.role !== 'parent') return null;
  const session = getSessionById(socket.data.sessionId);
  if (
    !session ||
    socket.data.sessionToken !== session.token ||
    !data ||
    data.sessionId !== session.id ||
    data.sessionToken !== session.token
  ) return null;
  return session;
}

app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: isAdminAuthenticated(req) });
});

app.get('/api/check-parent-session', (req, res) => {
  const session = getParentSessionFromRequest(req);
  if (!session) {
    return res.json({ registered: false });
  }

  return res.json({
    registered: true,
    sessionId: session.id,
    name: session.name,
    expiresAt: session.expiresAt,
    token: session.token
  });
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie('admin_token', SESSION_TOKEN, { httpOnly: true, maxAge: SESSION_TTL_MS });
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, message: 'パスワードが不正です' });
});

app.post('/api/logout', (req, res) => {
  const session = getParentSessionFromRequest(req);
  if (session) closeSession(session, '親画面との接続が終了しました。');
  res.clearCookie('admin_token');
  res.clearCookie('parent_session_id');
  res.clearCookie('parent_session_token');
  res.json({ success: true });
});

app.post('/api/register-parent', (req, res) => {
  const name = String(req.body && req.body.name ? req.body.name : '').trim();
  const reelCount = normalizeReelCount(req.body && req.body.reelCount);
  const session = createSessionRecord(name || '親', reelCount);

  res.cookie('parent_session_id', session.id, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
  res.cookie('parent_session_token', session.token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });

  return res.json({
    success: true,
    sessionId: session.id,
    name: session.name,
    expiresAt: session.expiresAt,
    token: session.token,
    reelCount: session.state.reelCount
  });
});

app.get('/api/history', (req, res) => {
  db.all('SELECT * FROM history ORDER BY executed_at DESC LIMIT 50', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/history/csv', (req, res) => {
  db.all('SELECT * FROM history ORDER BY executed_at DESC', [], (err, rows) => {
    if (err) return res.status(500).send('Error');
    let csv = 'ID,1つ目のレーン,2つ目のレーン,3つ目のレーン,実行日時\n';
    rows.forEach(r => {
      csv += `${r.id},"${r.result_left}","${r.result_center}","${r.result_right}","${r.executed_at}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="slot_history.csv"');
    res.send(csv);
  });
});

app.get('/api/qrcode', async (req, res) => {
  const session = getParentSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const host = req.headers.host;
  const childUrl = `http://${host}/child.html?sessionId=${session.id}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(childUrl);
    res.json({ url: childUrl, qr: qrDataUrl, sessionId: session.id, expiresAt: session.expiresAt });
  } catch (err) {
    res.status(500).json({ error: 'QR Code Generation Failed' });
  }
});

io.on('connection', (socket) => {
  socket.on('C2S_REGISTER_PARENT_CONNECT', (data) => {
    const session = getSessionAuth(data);
    if (!session) {
      return socket.emit('S2C_SESSION_ERROR', { message: 'セッションが無効です。再度登録してください。' });
    }

    if (socket.data.role && (
      socket.data.role !== 'parent' ||
      socket.data.sessionId !== session.id
    )) return;

    socket.data.role = 'parent';
    socket.data.sessionId = session.id;
    socket.data.sessionToken = session.token;
    session.parentSockets.add(socket);
    socket.join(sessionRoomName(session.id));
    socket.join(parentRoomName(session.id));

    socket.emit('S2C_SESSION_READY', {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      name: session.name,
      reelCount: session.state.reelCount,
      connectedChildren: Array.from(
        session.childSockets,
        (childSocket) => childSocket.data.childName || '名前未設定'
      ),
      pendingJoinRequests: Array.from(session.pendingJoinRequests.values(), (request) => ({
        requestId: request.id,
        name: request.name
      }))
    });
    socket.emit('S2C_SETTINGS_UPDATED', { reels: session.state.reels, reelCount: session.state.reelCount });
    socket.emit('S2C_STATE_SYNC', { ...session.state, reelCount: session.state.reelCount });
    emitRoomCount(session.id);
  });

  socket.on('C2S_JOIN_SESSION', (data) => {
    if (socket.data.role || socket.data.pendingJoinRequest) return;
    const ipAddress = socket.handshake.address || 'unknown';
    if (isJoinRateLimited(ipAddress)) {
      return socket.emit('S2C_SESSION_ERROR', {
        message: '接続IDの入力回数が上限に達しました。しばらく待ってから再度お試しください。'
      });
    }

    const name = typeof (data && data.name) === 'string' ? data.name.trim() : '';
    const sessionId = typeof (data && data.sessionId) === 'string' ? data.sessionId.trim() : '';
    if (!name || Array.from(name).length > 40 || !/^\d{4}$/.test(sessionId)) {
      return socket.emit('S2C_SESSION_ERROR', {
        message: '名前と4桁の接続IDを確認してください。'
      });
    }

    const session = getSessionById(sessionId);
    if (!session) {
      return socket.emit('S2C_SESSION_ERROR', { message: '4桁IDが無効か、有効期限が切れています。' });
    }

    if (session.pendingJoinRequests.size >= MAX_PENDING_JOIN_REQUESTS) {
      return socket.emit('S2C_SESSION_ERROR', {
        message: '接続リクエストが混み合っています。しばらくしてから再度お試しください。'
      });
    }
    if ((io.sockets.adapter.rooms.get(parentRoomName(session.id))?.size || 0) === 0) {
      return socket.emit('S2C_SESSION_ERROR', {
        message: '親画面が接続されていません。親画面が開いていることを確認してください。'
      });
    }

    const request = {
      id: crypto.randomUUID(),
      name,
      socket,
      timeout: null
    };
    request.timeout = setTimeout(() => {
      removeJoinRequest(session, request, '承認待ちの有効期限が切れました。もう一度接続してください。');
    }, JOIN_REQUEST_TTL_MS);
    socket.data.role = 'pending';
    socket.data.sessionId = session.id;
    socket.data.pendingJoinRequest = request;
    session.pendingJoinRequests.set(request.id, request);

    socket.emit('S2C_JOIN_PENDING', {
      message: '親画面で接続が承認されるまでお待ちください。'
    });
    io.to(parentRoomName(session.id)).emit('S2C_JOIN_REQUEST', {
      requestId: request.id,
      name
    });
  });

  socket.on('C2S_APPROVE_JOIN', (data) => {
    if (socket.data.role !== 'parent') return;
    const session = getParentSocketSession(socket, {
      sessionId: socket.data.sessionId,
      sessionToken: socket.data.sessionToken
    });
    if (!session) return;

    const request = session.pendingJoinRequests.get(data && data.requestId);
    if (!request || !request.socket.connected) return;

    session.pendingJoinRequests.delete(request.id);
    clearTimeout(request.timeout);
    request.socket.data.pendingJoinRequest = null;
    request.socket.data.role = 'child';
    request.socket.data.childName = request.name;
    request.socket.join(sessionRoomName(session.id));
    session.childSockets.add(request.socket);
    request.socket.emit('S2C_SESSION_JOINED', {
      sessionId: session.id,
      expiresAt: session.expiresAt,
      name: session.name,
      reelCount: session.state.reelCount
    });
    request.socket.emit('S2C_SETTINGS_UPDATED', {
      reels: session.state.reels,
      reelCount: session.state.reelCount
    });
    request.socket.emit('S2C_STATE_SYNC', { ...session.state, reelCount: session.state.reelCount });
    io.to(parentRoomName(session.id)).emit('S2C_JOIN_REQUEST_REMOVED', {
      requestId: request.id
    });
    emitRoomCount(session.id);
  });

  socket.on('C2S_REJECT_JOIN', (data) => {
    if (socket.data.role !== 'parent') return;
    const session = getParentSocketSession(socket, {
      sessionId: socket.data.sessionId,
      sessionToken: socket.data.sessionToken
    });
    if (!session) return;

    const request = session.pendingJoinRequests.get(data && data.requestId);
    if (!request) return;
    removeJoinRequest(session, request, '親画面で接続が拒否されました。');
  });

  socket.on('disconnect', () => {
    const sessionId = socket.data && socket.data.sessionId;
    if (!sessionId) return;

    const session = getSessionById(sessionId);
    if (socket.data.role === 'parent' && session) {
      session.parentSockets.delete(socket);
    } else if (socket.data.role === 'child' && session) {
      session.childSockets.delete(socket);
    } else if (socket.data.pendingJoinRequest && session) {
      removeJoinRequest(session, socket.data.pendingJoinRequest);
    }
    emitRoomCount(sessionId);
  });

  socket.on('C2S_UPDATE_SETTINGS', (data) => {
    const session = getParentSocketSession(socket, data);
    if (!session) {
      return socket.emit('S2C_SESSION_ERROR', { message: 'セッションが無効です。' });
    }

    if (!data || !data.reels) {
      return socket.emit('S2C_SESSION_ERROR', { message: '設定データがありません。' });
    }

    session.state.reels = normalizeReelState(data.reels);
    io.to(sessionRoomName(session.id)).emit('S2C_SETTINGS_UPDATED', {
      reels: session.state.reels,
      reelCount: session.state.reelCount
    });
  });

  socket.on('C2S_START_SLOT', (data) => {
    const session = getParentSocketSession(socket, data);
    if (!session) {
      return socket.emit('S2C_SESSION_ERROR', { message: 'セッションが無効です。' });
    }
    if (session.state.status === 'SPINNING') return;

    session.state.status = 'SPINNING';
    session.state.spinningReels = Array.from({ length: session.state.reelCount }, () => true);
    session.state.forcedResults = Array.from({ length: session.state.reelCount }, () => null);

    const reelKeys = ['left', 'center', 'right'];
    const activeKeys = reelKeys.slice(0, session.state.reelCount);
    session.state.currentResults = activeKeys.map((key, idx) => {
      if (session.state.forcedResults[idx] !== null && session.state.forcedResults[idx] !== undefined) {
        const forcedIndex = Number(session.state.forcedResults[idx]);
        return getReelValueByIndex(session.state.reels[key], forcedIndex) || getReelTextList(session.state.reels[key])[0] || '';
      }
      return pickWeightedValue(session.state.reels[key]);
    });

    io.to(sessionRoomName(session.id)).emit('S2C_SLOT_STARTED', {
      results: session.state.currentResults,
      reelCount: session.state.reelCount,
      timestamp: Date.now()
    });
  });

  socket.on('C2S_STOP_REEL', (data) => {
    const session = getParentSocketSession(socket, data);
    if (!session) {
      return socket.emit('S2C_SESSION_ERROR', { message: 'セッションが無効です。' });
    }

    const { reelIndex } = data;
    if (typeof reelIndex !== 'number' || reelIndex < 0 || reelIndex >= session.state.spinningReels.length || !session.state.spinningReels[reelIndex]) return;

    session.state.spinningReels[reelIndex] = false;
    const resultText = session.state.currentResults[reelIndex];
    const isAllStopped = session.state.spinningReels.every((s) => !s);

    if (isAllStopped) {
      session.state.status = 'IDLE';
      db.run(
        'INSERT INTO history (result_left, result_center, result_right) VALUES (?, ?, ?)',
        session.state.currentResults.slice(0, 3).concat(['', '']).slice(0, 3),
        function (err) {
          const historyId = this ? this.lastID : 0;
          io.to(sessionRoomName(session.id)).emit('S2C_REEL_STOPPED', {
            reelIndex,
            resultText,
            isAllStopped: true
          });
          io.to(sessionRoomName(session.id)).emit('S2C_ALL_STOPPED', {
            results: session.state.currentResults,
            historyId
          });
        }
      );
    } else {
      io.to(sessionRoomName(session.id)).emit('S2C_REEL_STOPPED', {
        reelIndex,
        resultText,
        isAllStopped: false
      });
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessionStore.entries()) {
    if (now > session.expiresAt) {
      closeSession(session, '親セッションの有効期限が切れました。');
    }
  }
  for (const [ipAddress, attempts] of joinAttemptsByIp.entries()) {
    if (now - attempts.startedAt >= JOIN_RATE_LIMIT_WINDOW_MS) {
      joinAttemptsByIp.delete(ipAddress);
    }
  }
}, 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});

function normalizeReelEntries(reelEntries) {
  if (!Array.isArray(reelEntries)) return [];
  const normalized = reelEntries
    .map((item) => {
      if (typeof item === 'string') {
        return { text: item.trim(), weight: 0 };
      }
      if (!item || typeof item !== 'object') {
        return null;
      }
      const text = String(item.text ?? item.label ?? item.value ?? '').trim();
      const rawWeight = Number(item.weight ?? item.percentage ?? 0);
      return {
        text,
        weight: Number.isFinite(rawWeight) ? rawWeight : 0
      };
    })
    .filter((item) => item && item.text);

  if (normalized.length === 0) return [];

  const total = normalized.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0);
  if (total <= 0) {
    const equalWeight = 100 / normalized.length;
    return normalized.map((item, idx) => ({
      text: item.text,
      weight: idx === normalized.length - 1 ? 100 - (equalWeight * (normalized.length - 1)) : equalWeight
    }));
  }

  const ratio = normalized.map((item) => ({
    text: item.text,
    weight: Math.round(((Number(item.weight) || 0) / total) * 100)
  }));
  const ratioTotal = ratio.reduce((sum, item) => sum + item.weight, 0);
  if (ratioTotal !== 100 && ratio.length > 0) {
    ratio[0].weight += 100 - ratioTotal;
  }
  return ratio;
}

function normalizeReelState(reels) {
  const nextReels = {};
  for (const key of ['left', 'center', 'right']) {
    const entries = normalizeReelEntries(reels && reels[key]);
    nextReels[key] = entries;
  }
  return nextReels;
}

function pickWeightedValue(reelEntries) {
  const entries = normalizeReelEntries(reelEntries);
  if (entries.length === 0) return '';

  const total = entries.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
  if (total <= 0) {
    return entries[Math.floor(Math.random() * entries.length)].text;
  }

  let randomValue = Math.random() * total;
  for (const item of entries) {
    randomValue -= Number(item.weight) || 0;
    if (randomValue <= 0) return item.text;
  }
  return entries[entries.length - 1].text;
}