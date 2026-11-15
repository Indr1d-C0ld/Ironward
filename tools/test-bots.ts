// Test end-to-end: avvia il server, collega bot WebSocket in cooperativa e in
// deathmatch, li fa muovere e sparare e controlla snapshot, ack ed eventi.
// Uso: node tools/test-bots.ts

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { InputCmd, ServerMsg, SnapMsg } from '../shared/protocol.ts';
import { GameDb } from '../server/db.ts';
import { emptyDelta } from '../shared/progression.ts';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const serverPath = fileURLToPath(new URL('../server/main.ts', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'ironward-test-'));
// Un veterano già di livello 3, per poter fondare un clan.
{
  const seedDb = new GameDb(join(dataDir, 'test.db'));
  const vet = await seedDb.register('Veterano', 'password9', 0);
  seedDb.applyDelta(vet!.id, { ...emptyDelta(), xp: 400 }, 'coop');
  await seedDb.register('Capo', 'password8', 0);
  seedDb.setRole('Capo', 'admin');
  seedDb.close();
}
const server = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: join(dataDir, 'test.db') }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((res) => server.stdout!.on('data', (d) => { if (String(d).includes('in ascolto')) res(); }));

interface Bot { id: number; snaps: SnapMsg[]; events: string[]; errors: string[]; ws: WebSocket; seq: number; reg: boolean; }

function bot(name: string, room: string, mode: string, token?: string): Promise<Bot> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const b: Bot = { id: -1, snaps: [], events: [], errors: [], ws, seq: 0, reg: false };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, color: 1, room, mode, seed: 'test-42', token })));
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ServerMsg;
      if (m.t === 'welcome') { b.id = m.id; b.reg = m.reg; res(b); }
      if (m.t === 'error') { b.errors.push(m.text); res(b); }
      if (m.t === 'snap') { b.snaps.push(m); for (const e of m.ev) b.events.push(e.e); }
    });
    ws.on('error', rej);
  });
}

function drive(b: Bot, seconds: number, fire: boolean): Promise<void> {
  return new Promise((res) => {
    let t = 0;
    const iv = setInterval(() => {
      t += 1 / 30;
      const cmd: InputCmd = { q: ++b.seq, f: 1, s: Math.sin(t * 2), a: t * 0.8, b: fire ? 1 : 0, w: -1 };
      b.ws.send(JSON.stringify({ t: 'in', c: [cmd] }));
      if (t >= seconds) { clearInterval(iv); res(); }
    }, 1000 / 30);
  });
}

let failed = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

try {
  const [a, b] = await Promise.all([bot('Alfa', 'coop-test', 'coop'), bot('Bravo', 'coop-test', 'coop')]);
  await Promise.all([drive(a, 3, true), drive(b, 3, false)]);
  await new Promise((r) => setTimeout(r, 300));
  const last = a.snaps[a.snaps.length - 1];
  ok(a.snaps.length > 40, `coop: snapshot ricevuti (${a.snaps.length})`);
  ok(last.p.length === 2, 'coop: due giocatori nello snapshot');
  ok(last.ack > 60, `coop: ack avanzato (${last.ack}/${a.seq})`);
  ok(last.en.length > 0, `coop: nemici presenti (${last.en.length})`);
  const first = a.snaps[0].p.find((p) => p.id === a.id)!;
  const end = last.p.find((p) => p.id === a.id)!;
  ok(Math.hypot(end.x - first.x, end.y - first.y) > 0.5 || end.al === 0, 'coop: il bot si è mosso');
  ok(a.events.includes('shot'), 'coop: eventi di sparo');
  ok(last.me.am < 8 || a.events.includes('pick'), `coop: munizioni consumate (${last.me.am})`);

  const [c, d] = await Promise.all([bot('Charlie', 'dm-test', 'dm'), bot('Delta', 'dm-test', 'dm')]);
  await Promise.all([drive(c, 2, true), drive(d, 2, true)]);
  await new Promise((r) => setTimeout(r, 300));
  const ld = c.snaps[c.snaps.length - 1];
  ok(ld.en.length === 0, 'dm: nessun nemico');
  ok(ld.p.length === 2, 'dm: due giocatori');

  const [f, g] = await Promise.all([bot('Foxtrot', 'ctf-test', 'ctf'), bot('Golf', 'ctf-test', 'ctf')]);
  await drive(f, 1, false);
  const lc = f.snaps[f.snaps.length - 1];
  const teamsSeen = new Set(lc.p.map((p) => p.tm));
  ok(teamsSeen.has(0) && teamsSeen.has(1), 'ctf: i due giocatori in squadre diverse');
  ok(Array.isArray(lc.ts) && typeof lc.tl === 'number' && lc.fl?.length === 8, 'ctf: punteggi, timer e documenti nello snapshot');
  f.ws.close(); g.ws.close();

  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()) as { rooms: unknown[] };
  ok(health.rooms.length === 3, 'health: tre stanze attive');
  const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
  ok(html.includes('IRONWARD'), 'http: pagina servita');
  const trav = await fetch(`http://127.0.0.1:${PORT}/..%2f..%2fpackage.json`);
  ok(trav.status === 403 || trav.status === 404, `http: path traversal bloccato (${trav.status})`);

  for (const x of [a, b, c, d]) x.ws.close();

  // --- Account: registrazione, partita, salvataggio delle statistiche.
  const base = `http://127.0.0.1:${PORT}`;
  const post = (path: string, body: unknown, tok?: string) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body),
  });
  const reg = await post('/api/register', { name: 'Echo', password: 'password1', color: 3 });
  const regBody = await reg.json() as { token: string; profile: { level: number; color: number } };
  ok(reg.status === 200 && !!regBody.token && regBody.profile.color === 3, 'api: registrazione');
  ok((await post('/api/register', { name: 'echo', password: 'password2' })).status === 409, 'api: nome già in uso');
  ok((await post('/api/register', { name: 'x', password: 'password2' })).status === 400, 'api: nome non valido');
  ok((await post('/api/login', { name: 'Echo', password: 'sbagliata' })).status === 401, 'api: password errata');
  const login = await post('/api/login', { name: 'Echo', password: 'password1' });
  ok(login.status === 200, 'api: accesso');
  const tok = regBody.token;
  ok((await post('/api/profile', { color: 7, hat: 0, tag: 'zz' }, tok)).status === 400, 'api: colore bloccato rifiutato');
  const prof = await post('/api/profile', { color: 1, hat: 0, tag: 'ab!c9' }, tok);
  ok(prof.status === 200 && ((await prof.json()) as { profile: { tag: string } }).profile.tag === '', 'api: la sigla libera non si imposta più dal profilo');

  // --- Clan via API
  type ClanResp = { error?: string; profile: { tag: string; clan: { owner: boolean } | null }; clan: { code?: string; members: unknown[] } | null };
  const vtok = ((await (await post('/api/login', { name: 'Veterano', password: 'password9' })).json()) as { token: string }).token;
  const lowLvl = await post('/api/clan/create', { tag: 'ech', name: 'Echi' }, tok);
  ok(lowLvl.status === 400 && ((await lowLvl.json()) as { error: string }).error.includes('livello'), 'api clan: fondazione bloccata sotto il livello 3');
  const created = await (await post('/api/clan/create', { tag: 'v e t', name: '  Veterani   di  ferro ' }, vtok)).json() as ClanResp;
  ok(created.profile.tag === 'VET' && created.profile.clan?.owner === true && !!created.clan?.code, 'api clan: clan fondato (sigla e nome ripuliti)');
  ok((await post('/api/clan/join', { code: 'ZZZZZZZZ' }, tok)).status === 400, 'api clan: codice errato');
  const joined = await (await post('/api/clan/join', { code: created.clan!.code }, tok)).json() as ClanResp;
  ok(joined.profile.tag === 'VET' && joined.clan?.members.length === 2, 'api clan: ingresso con codice');
  const pub = await fetch(base + '/api/clan/VET').then((r) => r.json()) as { clan: { name: string; code?: string } };
  ok(pub.clan.name === 'Veterani di ferro' && pub.clan.code === undefined, 'api clan: scheda pubblica senza codice');
  ok((await fetch(base + '/api/clans?by=wars')).status === 200, 'api clan: classifica dei clan');
  ok((await post('/api/clan/create', {}, undefined)).status === 401, 'api clan: serve l’accesso');

  const e = await bot('ignorato', 'acc-test', 'coop', tok);
  ok(e.reg, 'ws: accesso con token');
  const last2 = () => e.snaps[e.snaps.length - 1];
  await drive(e, 2, true);
  await new Promise((r) => setTimeout(r, 200));
  const meP = last2().p.find((p) => p.id === e.id)!;
  ok(meP.n === 'Echo' && meP.tg === 'VET' && meP.reg === 1, 'ws: nome e sigla del clan presi dal profilo');
  await post('/api/clan/kick', { name: 'Echo' }, vtok);
  await new Promise((r) => setTimeout(r, 200));
  ok(last2().p.find((p) => p.id === e.id)!.tg === '', 'ws: sigla tolta in partita quando si viene allontanati');
  const e2 = await bot('ignorato', 'acc-test', 'coop', tok);
  await new Promise((r) => setTimeout(r, 200));
  ok(e.errors.some((t) => t.includes('altra finestra')), 'ws: una sola sessione per account');
  e2.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const me = await fetch(base + '/api/me', { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json()) as { profile: { stats: { shots: number; playtime: number } } };
  ok(me.profile.stats.shots > 0, `db: colpi sparati salvati (${me.profile.stats.shots})`);
  const bad = await bot('x', 'acc-test', 'coop', 'token-non-valido-0123456789');
  ok(bad.errors.some((t) => t.startsWith('Sessione scaduta')), 'ws: token non valido rifiutato');
  const lb = await fetch(base + '/api/leaderboard?by=kills&period=week');
  ok(lb.status === 200, 'api: classifica');

  // --- Amministrazione
  const get = (path: string, t?: string) => fetch(base + path, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  const atok = ((await (await post('/api/login', { name: 'Capo', password: 'password8' })).json()) as { token: string; profile: { admin?: boolean } });
  ok(atok.profile.admin === true, 'admin: il profilo segnala il ruolo');
  ok((await get('/api/admin/overview')).status === 401 && (await get('/api/admin/overview', vtok)).status === 403, 'admin: rotte negate a ospiti e giocatori');
  const [k1, k2] = await Promise.all([bot('Kilo', 'adm-test', 'dm'), bot('Lima', 'adm-test', 'dm')]);
  await drive(k1, 0.5, false);
  const ov = await (await get('/api/admin/overview', atok.token)).json() as { rooms: { name: string; players: { id: number; name: string }[] }[]; counts: { admins: number } };
  const admRoom = ov.rooms.find((r) => r.name === 'adm-test');
  ok(admRoom?.players.length === 2 && ov.counts.admins === 1, 'admin: panoramica con stanze e giocatori');
  const bc = await (await post('/api/admin/broadcast', { text: 'Manutenzione alle 22', room: 'adm-test' }, atok.token)).json() as { rooms: number };
  await new Promise((r) => setTimeout(r, 200));
  ok(bc.rooms === 1 && k2.snaps.some((sn) => sn.ev.some((ev) => ev.e === 'msg' && ev.text.includes('Manutenzione'))), 'admin: messaggio ai giocatori');
  const kr = await post('/api/admin/kick', { room: 'adm-test', id: k1.id, reason: 'prova' }, atok.token);
  await new Promise((r) => setTimeout(r, 200));
  ok(kr.status === 200 && k1.errors.some((t) => t.startsWith('Espulso')), 'admin: espulsione dalla stanza');
  const e3 = await bot('ignorato', 'adm-test', 'dm', tok);
  const ban = await post('/api/admin/ban', { name: 'Echo', reason: 'linguaggio offensivo' }, atok.token);
  await new Promise((r) => setTimeout(r, 200));
  ok(ban.status === 200 && e3.errors.some((t) => t.includes('sospeso')), 'admin: sospensione disconnette il giocatore');
  const relog = await post('/api/login', { name: 'Echo', password: 'password1' });
  ok(relog.status === 403 && ((await relog.json()) as { error: string }).error.includes('linguaggio offensivo'), 'admin: account sospeso non accede');
  ok((await post('/api/admin/ban', { name: 'Capo' }, atok.token)).status === 400, 'admin: non ci si sospende da soli');
  ok((await post('/api/admin/unban', { name: 'Echo' }, atok.token)).status === 200 && (await post('/api/login', { name: 'Echo', password: 'password1' })).status === 200, 'admin: riattivazione');
  ok((await post('/api/admin/close', { room: 'adm-test' }, atok.token)).status === 200, 'admin: chiusura stanza');
  await new Promise((r) => setTimeout(r, 200));
  ok(k2.errors.length > 0, 'admin: chi era nella stanza chiusa viene avvisato');
  const logRows = await (await get('/api/admin/log', atok.token)).json() as { rows: { action: string }[] };
  ok(['espulsione', 'sospensione', 'riattivazione', 'messaggio', 'chiusura stanza'].every((a) => logRows.rows.some((r) => r.action === a)), 'admin: azioni nel registro');
  ok((await fetch(base + '/admin.html')).status === 200, 'admin: pagina servita');
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `FALLITO: ${failed} controlli` : 'OK: tutti i controlli superati');
process.exit(failed ? 1 : 0);
