'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'w26-7fk3qm';
const MASTER_KEY = process.env.MASTER_KEY || 'mx26-83hf9q';
const MAX_WALL = 300;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const BLOCK_WORDS = [
  '傻逼', '操你', '妈的', '他妈', '特么', '赌博', '加微信', '代理', '刷单', '贷款',
  '草泥马', '卧槽', '我操', '滚蛋', '滚开', '去死', '贱人', '贱货', '婊', '鸡巴',
  '白痴', '脑残', '废物', '傻子', '智障', '畜生', '王八', '混蛋', '流氓', '色情',
  '约炮', '卖淫', '嫖娼', '毒品', '子弹', '枪支', '自杀教程'
];

function freshState() {
  return {
    phase: 'idle',
    startedAt: 0,
    duration: 60,
    tug: { a: 0, b: 0 },
    guests: {},
    wall: [],
    winners: [],
    result: null
  };
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return Object.assign(freshState(), JSON.parse(raw));
  } catch (e) {
    return freshState();
  }
}

const state = load();

function persistNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  } catch (e) { /* ignore */ }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 400);
}

function active() {
  return state.startedAt > 0 && Date.now() < state.startedAt + state.duration * 1000;
}

function remainSec() {
  if (!state.startedAt) return 0;
  return Math.max(0, Math.ceil((state.startedAt + state.duration * 1000 - Date.now()) / 1000));
}

function rank() {
  return Object.values(state.guests)
    .filter((g) => g.coins > 0)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 10)
    .map((g, i) => ({ rank: i + 1, name: g.name, team: g.team, coins: g.coins }));
}

function snapshot(role, id) {
  const base = {
    phase: state.phase,
    startedAt: state.startedAt,
    remain: remainSec(),
    now: Date.now(),
    tug: { a: state.tug.a, b: state.tug.b },
    result: state.result,
    winners: state.winners,
    count: Object.keys(state.guests).length,
    wall: state.wall.slice(-30),
    rank: rank()
  };
  if (role === 'screen' || role === 'admin') {
    base.guests = state.guests;
    base.wall = state.wall.slice(-60);
  } else {
    base.me = state.guests[id] || null;
  }
  return base;
}

const clients = new Set();
let dirty = true;
function markDirty() {
  dirty = true;
}

setInterval(() => {
  if (state.phase === 'tug' && !state.result && state.startedAt && !active()) {
    state.result = {
      winner: state.tug.a >= state.tug.b ? 'a' : 'b',
      a: state.tug.a,
      b: state.tug.b
    };
    markDirty();
    save();
  }
  if (!dirty || clients.size === 0) return;
  dirty = false;
  const screenSnap = JSON.stringify(snapshot('screen', ''));
  for (const c of clients) {
    try {
      const payload = c.role === 'phone' ? JSON.stringify(snapshot('phone', c.id)) : screenSnap;
      c.res.write('data: ' + payload + '\n\n');
    } catch (e) {
      clients.delete(c);
    }
  }
}, 120);

setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': keep\n\n');
    } catch (e) {
      clients.delete(c);
    }
  }
}, 20000);

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 200000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(d || '{}'));
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, obj, code) {
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function handleStream(req, res, u) {
  const role = u.searchParams.get('role') === 'screen' || u.searchParams.get('role') === 'admin' ? u.searchParams.get('role') : 'phone';
  const id = u.searchParams.get('id') || '';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  res.write('data: ' + JSON.stringify(snapshot(role, id)) + '\n\n');
  const client = { res, role, id };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

async function handleApi(req, res, u) {
  const p = u.pathname;
  const body = req.method === 'POST' ? await readBody(req) : {};
  const id = String(body.id || u.searchParams.get('id') || '').slice(0, 48);

  if (p === '/api/state') {
    return sendJson(res, snapshot(u.searchParams.get('role') || 'phone', id));
  }

  if (p === '/api/join') {
    if (!id) return sendJson(res, { ok: false, msg: '缺少标识' }, 400);
    const requested = String(body.name || '').trim().slice(0, 12);
    if (requested && BLOCK_WORDS.some((w) => requested.includes(w))) {
      return sendJson(res, { ok: false, msg: '这个名字不太合适，换一个吧' });
    }
    const team = body.team === 'b' ? 'b' : 'a';
    let g = state.guests[id];

    if (g && g.nameLocked) {
      // 已绑定设备：改名必须先由总控授权，且只放行一次
      if (requested && requested !== g.name) {
        if (!g.renameAllowed) {
          return sendJson(res, {
            ok: false, locked: true, name: g.name, team: g.team,
            msg: '这部手机已绑定「' + g.name + '」，改名需要总控授权'
          }, 403);
        }
        g.name = requested;
        g.renameAllowed = false; // 授权一次性，改完即收回
      }
      if (team !== g.team && body.forceTeam) g.team = team;
    } else {
      if (!g) g = { id, coins: 0 };
      g.name = requested || '神秘来宾';
      g.team = team;
      g.nameLocked = true;
      g.renameAllowed = false;
      g.muted = false;
      g.joinedAt = Date.now();
    }
    g.ts = Date.now();
    state.guests[id] = g;
    markDirty();
    save();
    return sendJson(res, { ok: true, team: g.team, name: g.name, locked: true });
  }

  if (p === '/api/tap') {
    const g = state.guests[id];
    if (!g || state.phase !== 'tug' || !active()) return sendJson(res, { ok: false });
    const now = Date.now();
    if (now - (g.lastTap || 0) < 110) return sendJson(res, { ok: false });
    g.lastTap = now;
    const n = Math.max(0, Math.min(20, Number(body.n) || 1));
    if (g.team === 'b') state.tug.b += n;
    else state.tug.a += n;
    markDirty();
    return sendJson(res, { ok: true });
  }

  if (p === '/api/rain') {
    const g = state.guests[id];
    if (!g) return sendJson(res, { ok: false });
    const coins = Math.max(0, Math.min(9999, Math.floor(Number(body.coins) || 0)));
    if (coins > (g.coins || 0)) {
      g.coins = coins;
      markDirty();
      save();
    }
    return sendJson(res, { ok: true });
  }

  if (p === '/api/wall') {
    const g = state.guests[id];
    if (!g) return sendJson(res, { ok: false, msg: '请先入场' });
    if (g.muted) return sendJson(res, { ok: false, muted: true, msg: '你已被禁言，有疑问请联系工作人员' });
    const text = String(body.text || '').trim().slice(0, 40);
    if (!text) return sendJson(res, { ok: false, msg: '说点什么吧' });
    const now = Date.now();
    if (now - (g.lastWall || 0) < 3000) return sendJson(res, { ok: false, msg: '慢一点，一次一句' });
    if (BLOCK_WORDS.some((w) => text.includes(w))) return sendJson(res, { ok: false, msg: '换个说法试试' });
    g.lastWall = now;
    g.wallCount = (g.wallCount || 0) + 1;
    state.wall.push({
      id: Math.random().toString(36).slice(2, 9),
      uid: g.id,
      name: g.name,
      team: g.team,
      text,
      ts: now
    });
    if (state.wall.length > MAX_WALL) state.wall = state.wall.slice(-MAX_WALL);
    markDirty();
    save();
    return sendJson(res, { ok: true });
  }

  if (p === '/api/admin') {
    const key = body.key || u.searchParams.get('k');
    if (key !== ADMIN_KEY) return sendJson(res, { ok: false, msg: '口令不对' }, 403);
    const a = body.action;

    if (a === 'phase') {
      state.phase = ['idle', 'tug', 'rain', 'wall'].includes(body.value) ? body.value : 'idle';
      state.startedAt = 0;
      state.result = null;
    } else if (a === 'start') {
      state.phase = body.value || state.phase;
      state.duration = Math.max(10, Math.min(600, Number(body.duration) || 60));
      state.startedAt = Date.now();
      state.result = null;
      if (state.phase === 'tug') state.tug = { a: 0, b: 0 };
    } else if (a === 'stop') {
      state.result = state.result || {
        winner: state.tug.a >= state.tug.b ? 'a' : 'b',
        a: state.tug.a,
        b: state.tug.b
      };
      state.startedAt = 0;
    } else if (a === 'resetTug') {
      state.tug = { a: 0, b: 0 };
      state.result = null;
      state.startedAt = 0;
    } else if (a === 'resetRain') {
      Object.values(state.guests).forEach((g) => {
        g.coins = 0;
      });
    } else if (a === 'draw') {
      const n = Math.max(1, Math.min(20, Number(body.n) || 1));
      const wonIds = new Set(state.winners.map((w) => w.uid));
      const pool = Object.values(state.guests).filter((g) => !wonIds.has(g.id));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      pool.slice(0, n).forEach((g) => {
        state.winners.push({ uid: g.id, name: g.name, team: g.team, ts: Date.now() });
      });
    } else if (a === 'clearWinners') {
      state.winners = [];
    } else if (a === 'clearWall') {
      state.wall = [];
    } else if (a === 'delWall') {
      state.wall = state.wall.filter((m) => m.id !== body.wallId);
    } else if (a === 'resetAll') {
      Object.assign(state, freshState());
    }

    markDirty();
    save();
    return sendJson(res, { ok: true, state: snapshot('admin', '') });
  }

  if (p === '/api/master') {
    const key = body.key || u.searchParams.get('k');
    if (key !== MASTER_KEY) return sendJson(res, { ok: false, msg: '总控口令不对' }, 403);
    const a = body.action;

    if (a === 'users') {
      const wonMap = {};
      state.winners.forEach((w) => { wonMap[w.uid] = (wonMap[w.uid] || 0) + 1; });
      const users = Object.values(state.guests).map((g) => ({
        id: g.id,
        name: g.name,
        team: g.team,
        coins: g.coins || 0,
        muted: !!g.muted,
        renameAllowed: !!g.renameAllowed,
        joinedAt: g.joinedAt || g.ts || 0,
        wallCount: g.wallCount || 0,
        won: wonMap[g.id] || 0
      })).sort((x, y) => y.joinedAt - x.joinedAt);
      return sendJson(res, { ok: true, users, wall: state.wall.slice(-200), winners: state.winners });
    }

    if (a === 'mute' || a === 'unmute') {
      const g = state.guests[body.uid];
      if (!g) return sendJson(res, { ok: false, msg: '用户不存在' }, 404);
      g.muted = a === 'mute';
      markDirty();
      save();
      return sendJson(res, { ok: true, uid: g.id, muted: g.muted });
    }

    if (a === 'allowRename') {
      const g = state.guests[body.uid];
      if (!g) return sendJson(res, { ok: false, msg: '用户不存在' }, 404);
      g.renameAllowed = true;
      markDirty();
      save();
      return sendJson(res, { ok: true, uid: g.id, renameAllowed: true });
    }

    if (a === 'userWall') {
      const msgs = state.wall.filter((m) => m.uid === body.uid);
      const won = state.winners.filter((w) => w.uid === body.uid);
      const g = state.guests[body.uid] || {};
      return sendJson(res, { ok: true, name: g.name || '', msgs, won });
    }

    if (a === 'rename') {
      // 总控直接替用户改名
      const g = state.guests[body.uid];
      const name = String(body.name || '').trim().slice(0, 12);
      if (!g || !name) return sendJson(res, { ok: false, msg: '参数不对' }, 400);
      if (BLOCK_WORDS.some((w) => name.includes(w))) return sendJson(res, { ok: false, msg: '名字不合规' });
      g.name = name;
      g.renameAllowed = false;
      markDirty();
      save();
      return sendJson(res, { ok: true, uid: g.id, name: g.name });
    }

    return sendJson(res, { ok: false, msg: 'not found' }, 404);
  }

  return sendJson(res, { ok: false, msg: 'not found' }, 404);
}

const ALIAS = {
  '/big': '/screen',
  '/bigscreen': '/screen',
  '/tv': '/screen',
  '/daping': '/screen',
  '/control': '/admin',
  '/host': '/admin',
  '/manage': '/admin',
  '/console': '/admin',
  '/qr': '/',
  '/join': '/'
};

const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<circle cx="32" cy="32" r="30" fill="#7A1F30"/>' +
  '<circle cx="32" cy="32" r="22" fill="none" stroke="#C0A062" stroke-width="2"/>' +
  '<text x="32" y="44" font-size="28" text-anchor="middle" fill="#FDF6EE" font-family="serif">囍</text></svg>';

function notFoundPage(res, p) {
  const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>页面不存在</title>' +
    '<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#FBF7F0;color:#3A2A20;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center}' +
    'h1{font-family:"Songti SC",serif;font-size:22px;font-weight:400;color:#7A1F30;letter-spacing:.12em;margin:0 0 8px}' +
    'p{font-size:13px;color:#A8917B;margin:0 0 6px;line-height:1.8}' +
    'code{background:#F3E9DC;padding:2px 6px;border-radius:4px;font-size:12px;color:#7A1F30}' +
    'a{display:block;width:230px;margin:9px auto 0;padding:13px;border-radius:10px;background:#7A1F30;' +
    'color:#FDF6EE;text-decoration:none;font-size:14px;letter-spacing:.14em}' +
    'a.ghost{background:#fff;color:#7A1F30;border:1px solid #E2D2C3}</style></head><body>' +
    '<h1>这个地址不存在</h1>' +
    '<p>你访问的是 <code>' + String(p).replace(/[<>&"]/g, '') + '</code></p>' +
    '<p>下面三个入口都在</p>' +
    '<a href="/">宾客扫码进这个</a>' +
    '<a class="ghost" href="/screen">大屏投影</a>' +
    '<a class="ghost" href="/admin">主持人控制台</a>' +
    '<a class="ghost" href="/guide">现场操作指南</a>' +
    '</body></html>';
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveStatic(req, res, p) {
  if (p === '/favicon.ico' || p === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    return res.end(FAVICON);
  }

  let file = decodeURIComponent(p);
  if (file.indexOf('..') !== -1) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  if (ALIAS[file]) {
    res.writeHead(302, { Location: ALIAS[file] + (req.url.indexOf('?') > -1 ? req.url.slice(req.url.indexOf('?')) : '') });
    return res.end();
  }

  if (file !== '/' && file.slice(-1) === '/') file = file.slice(0, -1);
  if (file === '/') file = '/index.html';
  if (!path.extname(file)) file += '.html';

  const full = path.join(PUBLIC, file);
  fs.readFile(full, (err, buf) => {
    if (err) return notFoundPage(res, p);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

function onRequest(req, res) {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (u.pathname === '/healthz' || u.pathname === '/api/ping') {
    return sendJson(res, { ok: true, uptime: Math.round(process.uptime()), port: PORT });
  }
  if (u.pathname === '/api/stream') return handleStream(req, res, u);
  if (u.pathname.indexOf('/api/') === 0) {
    return handleApi(req, res, u).catch(() => sendJson(res, { ok: false }, 500));
  }
  serveStatic(req, res, u.pathname);
}

const server = http.createServer(onRequest);

// 云托管/容器平台的监听端口并不总是通过 PORT 传进来，
// 这里额外监听常见端口，避免"容器起来了但健康检查打不通"。
const EXTRA = String(process.env.EXTRA_PORTS || '3000,80,8080')
  .split(',')
  .map(function (x) { return Number(x.trim()); })
  .filter(function (n) { return n > 0 && n < 65536 && n !== PORT; });

const extraServers = [];
EXTRA.forEach(function (p) {
  try {
    const s = http.createServer(onRequest);
    s.on('error', function () { /* 端口被占用或无权监听，忽略 */ });
    s.listen(p, HOST, function () {
      console.log('extra listen on ' + p);
      extraServers.push(s);
    });
  } catch (e) { /* ignore */ }
});

server.on('error', function (e) {
  console.error('listen failed on ' + PORT + ': ' + e.message);
});

server.listen(PORT, HOST, function () {
  console.log('wedding live on http://' + HOST + ':' + PORT);
  console.log('node ' + process.version + ' | pid ' + process.pid + ' | PORT env ' + (process.env.PORT || 'unset'));
});

function shutdown () {
  console.log('shutting down');
  try { persistNow(); } catch (e) {}
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
