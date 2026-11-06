// Robo Violet 3D — serveur web + multijoueur (WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

/* ---------- fichiers du jeu ---------- */
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '') url = '/index.html';
  const file = path.normalize(path.join(ROOT, url));
  const base = path.basename(file);
  if (!file.startsWith(ROOT) || /^(server\.js|package(-lock)?\.json|world\.json|clans\.json)$/.test(base) || file.includes('node_modules')) { res.writeHead(403); return res.end('Interdit'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=600' });
    res.end(data);
  });
});

/* ---------- monde partagé du mode Créatif ---------- */
const WORLD_FILE = path.join(__dirname, 'world.json');
let world = { b: {}, o: {}, od: {}, n: {} };
try { world = Object.assign(world, JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'))); } catch (e) {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(WORLD_FILE, JSON.stringify(world), () => {}); } }, 15000);
const snapshot = () => ({ b: Object.entries(world.b), o: Object.values(world.o), od: Object.keys(world.od), n: Object.keys(world.n).map(Number) });
const num = v => typeof v === 'number' && isFinite(v);
function applyOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (op.k === 'b' && [op.x, op.y, op.z].every(v => Number.isInteger(v) && Math.abs(v) < 500)) {
    const k = op.x + ',' + op.y + ',' + op.z;
    if (op.v) { if (typeof op.v !== 'string' || op.v.length > 20 || Object.keys(world.b).length > 30000) return false; world.b[k] = op.v; } else delete world.b[k];
  } else if (op.k === 'o' && Array.isArray(op.a) && typeof op.a[0] === 'string' && op.a[0].length < 20 && op.a.slice(1).every(num)) {
    if (Object.keys(world.o).length > 5000) return false;
    const key = op.a[0] + '|' + op.a[1].toFixed(1) + '|' + op.a[2].toFixed(1); world.o[key] = op.a.slice(0, 5); delete world.od[key];
  } else if (op.k === 'od' && typeof op.key === 'string' && op.key.length < 60) {
    if (world.o[op.key]) delete world.o[op.key]; else world.od[op.key] = 1;
  } else if (op.k === 'n' && Number.isInteger(op.t) && op.t >= 0 && op.t < 220 * 220) {
    world.n[op.t] = 1;
  } else return false;
  dirty = true; return true;
}

/* ---------- clans ---------- */
const CLAN_FILE = path.join(__dirname, 'clans.json');
let clans = {}; try { clans = JSON.parse(fs.readFileSync(CLAN_FILE, 'utf8')) || {}; } catch (e) {}
let clansDirty = false; setInterval(() => { if (clansDirty) { clansDirty = false; fs.writeFile(CLAN_FILE, JSON.stringify(clans), () => {}); } }, 10000);
const clanOf = uid => { for (const id in clans) if (clans[id].members[uid]) return id; return null; };
function clanView(id) { const c = clans[id]; if (!c) return null; const online = new Set([...players.values()].map(p => p.uid));
  return { id, name: c.name, tag: c.tag, color: c.color, members: Object.entries(c.members).map(([u, n]) => ({ name: n, online: online.has(u), leader: u === c.leader })) }; }
function sendClan(p, extra) { send(p.ws, Object.assign({ t: 'clanInfo', clan: p.clan ? clanView(p.clan) : null }, extra || {})); }
function refreshClan(id) { for (const q of players.values()) if (q.clan === id) sendClan(q); }
function tagUpdate(p) { const c = p.clan && clans[p.clan]; p.tag = c ? c.tag : null; p.tcol = c ? c.color : null; if (p.room) toRoom(p.room, { t: 'tag', id: p.id, tag: p.tag, color: p.tcol }, p); }

/* ---------- chat ---------- */
const BAD = ['connard', 'connasse', 'conne', 'con', 'pute', 'putain', 'salope', 'salaud', 'encule', 'enculé', 'merde', 'batard', 'bâtard', 'fdp', 'ntm', 'nique', 'niquer', 'pd', 'tg', 'enfoiré', 'enfoire', 'bouffon', 'abruti', 'débile', 'debile', 'idiot', 'crétin', 'cretin', 'mongol', 'fuck', 'shit', 'bitch'];
const BADRE = new RegExp('(^|[^a-zàâçéèêëîïôûùüÿ])(' + BAD.join('|') + ')(?=$|[^a-zàâçéèêëîïôûùüÿ])', 'gi');
const cleanChat = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80).replace(BADRE, (m, a, w) => a + '★'.repeat(w.length));

/* ---------- joueurs ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const players = new Map(); let nextId = 1;
const ROOMS = ['adv', 'cre', 'arena', 'coopL', 'coop1', 'coop2', 'coop3'];
const CAP = { coop1: 2, coop2: 2, coop3: 2 };
const roomProg = {}; const scores = {};
const clean = s => String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 14).replace(BADRE, (m, a, w) => a + '★'.repeat(w.length)) || 'Héros';
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function toRoom(room, o, except) { const m = JSON.stringify(o); for (const p of players.values()) if (p.room === room && p !== except && p.ws.readyState === 1) p.ws.send(m); }
const roomCount = r => [...players.values()].filter(p => p.room === r).length;
const pub = p => ({ id: p.id, name: p.name, look: p.look, s: p.s, tag: p.tag, tcol: p.tcol });
function occ() { const c = [1, 2, 3].map(n => roomCount('coop' + n)); for (const r of ['coopL', 'coop1', 'coop2', 'coop3']) toRoom(r, { t: 'occ', c }); }
function sendScores() { const l = Object.entries(scores).filter(([id]) => players.get(+id) && players.get(+id).room === 'arena').map(([id, k]) => [+id, players.get(+id).name, k]).sort((a, b) => b[2] - a[2]); toRoom('arena', { t: 'score', l }); }
function leaveRoom(p) { if (!p.room) return; const r = p.room; p.room = null; toRoom(r, { t: 'leave', id: p.id }); if (CAP[r] && roomCount(r) === 0) delete roomProg[r]; if (r === 'arena') { delete scores[p.id]; sendScores(); } if (r.startsWith('coop')) occ(); }

wss.on('connection', ws => {
  const p = { id: nextId++, ws, uid: null, name: 'Héros', room: null, look: null, s: null, dirty: false, last: 0, alive: true, clan: null, tag: null, tcol: null };
  players.set(p.id, p);
  send(ws, { t: 'time', now: Date.now() });
  ws.on('pong', () => { p.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'hello') {
      p.name = clean(m.name || p.name);
      if (typeof m.uid === 'string' && m.uid.length < 40 && !p.uid) { p.uid = m.uid; p.clan = clanOf(p.uid); const c = p.clan && clans[p.clan]; p.tag = c ? c.tag : null; p.tcol = c ? c.color : null; sendClan(p); if (p.clan) refreshClan(p.clan); }
      const want = ROOMS.includes(m.room) ? m.room : null;
      if (want && CAP[want] && want !== p.room && roomCount(want) >= CAP[want]) { send(ws, { t: 'full', room: want }); return; }
      leaveRoom(p); p.s = null; p.room = want;
      if (!p.room) return;
      const others = [...players.values()].filter(q => q.room === p.room && q !== p && q.look).map(pub);
      send(ws, { t: 'welcome', id: p.id, room: p.room, now: Date.now(), players: others, world: p.room === 'cre' ? snapshot() : null, prog: roomProg[p.room] || null });
      send(ws, { t: 'time', now: Date.now() });
      if (p.look) toRoom(p.room, { t: 'join', p: pub(p) }, p);
      if (p.room.startsWith('coop')) occ();
      if (p.room === 'arena') { scores[p.id] = scores[p.id] || 0; sendScores(); }
    } else if (m.t === 'look' && m.look && typeof m.look.race === 'string') {
      const first = !p.look; p.look = { race: m.look.race.slice(0, 12), pal: m.look.pal | 0, eq: m.look.eq && typeof m.look.eq === 'object' ? m.look.eq : {} };
      if (JSON.stringify(p.look).length > 800) p.look.eq = {};
      if (p.room) toRoom(p.room, first ? { t: 'join', p: pub(p) } : { t: 'look', id: p.id, look: p.look }, p);
    } else if (m.t === 's' && Array.isArray(m.s) && m.s.length === 8 && m.s.every(num)) {
      p.s = [p.id, ...m.s]; p.dirty = true;
    } else if (m.t === 'chat' && typeof m.s === 'string') {
      const now = Date.now(); if (now - p.last < 900 || !p.room) return; p.last = now;
      const txt = cleanChat(m.s); if (!txt) return;
      toRoom(p.room, { t: 'chat', id: p.id, name: p.name, tag: p.tag, s: txt }, p);
    } else if (m.t === 'fx' && p.room) {
      toRoom(p.room, { t: 'fx', id: p.id, k: m.k ? 1 : 0 }, p);
    } else if (m.t === 'build' && p.room === 'cre') {
      if (applyOp(m.op)) toRoom('cre', { t: 'build', op: m.op }, p);
    } else if (m.t === 'prog' && p.room && CAP[p.room] && m.p && typeof m.p === 'object') {
      if (JSON.stringify(m.p).length < 12000) { roomProg[p.room] = m.p; toRoom(p.room, { t: 'prog', p: m.p }, p); }
    } else if (m.t === 'hit' && p.room === 'arena') {
      const q = players.get(m.id); if (q && q.room === 'arena' && num(m.d) && num(m.x) && num(m.z)) send(q.ws, { t: 'hit', from: p.id, d: Math.max(1, Math.min(15, m.d | 0)), x: m.x, z: m.z });
    } else if (m.t === 'ko' && p.room === 'arena') {
      const k = players.get(m.by); if (k && k.room === 'arena' && k !== p) { scores[k.id] = (scores[k.id] || 0) + 1; toRoom('arena', { t: 'kofeed', a: k.name, aId: k.id, b: p.name }); sendScores(); }
    } else if (m.t === 'clan' && p.uid) {
      if (m.a === 'create') {
        if (p.clan) return send(ws, { t: 'clanErr', e: 'Tu es déjà dans un clan.' });
        const name = clean(m.name).slice(0, 16), tag = String(m.tag || '').toUpperCase();
        if (name.length < 3 || !/^[A-Z0-9]{2,4}$/.test(tag)) return send(ws, { t: 'clanErr', e: 'Nom ou TAG invalide.' });
        if (Object.values(clans).some(c => c.tag === tag)) return send(ws, { t: 'clanErr', e: 'Ce TAG est déjà pris !' });
        const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        clans[id] = { name, tag, color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#ff5a3a', leader: p.uid, members: { [p.uid]: p.name } }; clansDirty = true;
        p.clan = id; sendClan(p, { created: 1 }); tagUpdate(p);
      } else if (m.a === 'invite') {
        const q = players.get(m.to); const c = p.clan && clans[p.clan];
        if (!c || !q || !q.uid) return; if (q.clan) return send(ws, { t: 'clanErr', e: q.name + ' est déjà dans un clan.' });
        q.invites = q.invites || new Set(); q.invites.add(p.clan);
        send(q.ws, { t: 'clanInvite', from: p.name, clanId: p.clan, name: c.name, tag: c.tag });
      } else if (m.a === 'join') {
        const c = clans[m.clanId]; if (!c || p.clan || !p.invites || !p.invites.has(m.clanId)) return;
        if (Object.keys(c.members).length >= 30) return send(ws, { t: 'clanErr', e: 'Ce clan est complet.' });
        c.members[p.uid] = p.name; clansDirty = true; p.clan = m.clanId; p.invites.delete(m.clanId);
        sendClan(p, { joined: 1 }); tagUpdate(p); refreshClan(m.clanId);
      } else if (m.a === 'leave') {
        const id = p.clan, c = clans[id]; if (!c) return; delete c.members[p.uid];
        if (!Object.keys(c.members).length) delete clans[id]; else if (c.leader === p.uid) c.leader = Object.keys(c.members)[0];
        clansDirty = true; p.clan = null; sendClan(p); tagUpdate(p); if (clans[id]) refreshClan(id);
      }
    }
  });
  ws.on('close', () => { players.delete(p.id); leaveRoom(p); if (p.clan) refreshClan(p.clan); });
});

// positions envoyées 10 fois par seconde
setInterval(() => {
  for (const room of ROOMS) {
    const l = []; for (const p of players.values()) if (p.room === room && p.dirty && p.s) { l.push(p.s); p.dirty = false; }
    if (l.length) toRoom(room, { t: 'st', l });
  }
}, 100);
// heure commune (jour/nuit/météo) toutes les 60 s
setInterval(() => { const m = JSON.stringify({ t: 'time', now: Date.now() }); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(m); }, 60000);
// coupe les connexions mortes
setInterval(() => { for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; try { p.ws.ping(); } catch (e) {} } }, 30000);

server.listen(PORT, () => console.log('Robo Violet 3D en ligne sur le port ' + PORT));
