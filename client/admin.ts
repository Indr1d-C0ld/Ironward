// Pagina di amministrazione: stanze attive, giocatori, clan, registro delle azioni.
// Usa la stessa sessione del gioco (token in localStorage); il server accetta solo
// gli account con ruolo admin.

import { MODE_NAMES, TEAMS, type GameMode } from '../shared/defs.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let token: string | null = null;
try { token = localStorage.getItem('iw-token'); } catch { /* archivio non disponibile */ }

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Errore ${res.status}`), { status: res.status });
  return data as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function btn(text: string, onClick: () => void, cls = 'act'): HTMLButtonElement {
  const b = el('button', text, cls);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function row(cells: (string | Node)[], head = false): HTMLTableRowElement {
  const tr = el('tr');
  for (const c of cells) {
    const td = el(head ? 'th' : 'td');
    if (typeof c === 'string') td.textContent = c; else td.appendChild(c);
    tr.appendChild(td);
  }
  return tr;
}

const msgBox = $('msg');
function say(text: string, ok = true): void {
  msgBox.textContent = text;
  msgBox.className = `msg ${ok ? 'good' : 'bad'}`;
}

/** Esegue un'azione, mostra l'esito e ricarica la scheda corrente. */
async function act(path: string, body: Record<string, unknown>, done: string): Promise<void> {
  try {
    await api(`/api/admin/${path}`, body);
    say(done);
  } catch (err) {
    say((err as Error).message, false);
  }
  await refresh();
}

const fmtDate = (ts: number) => new Date(ts).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------ server

interface LivePlayer { id: number; name: string; tag: string; userId: number | null; level: number; team: number; frags: number; score: number; }
interface LiveRoom { name: string; mode: string; level: number; timeLeft: number; players: LivePlayer[]; }

async function loadServer(): Promise<void> {
  const r = await api<{ rooms: LiveRoom[]; counts: { users: number; clans: number; banned: number; admins: number }; me: string }>('/api/admin/overview');
  $('who').textContent = `connesso come ${r.me}`;
  const online = r.rooms.reduce((n, x) => n + x.players.length, 0);
  const counts = $('counts');
  counts.replaceChildren(...([
    [online, 'in partita'], [r.rooms.length, 'stanze attive'], [r.counts.users, 'account'],
    [r.counts.clans, 'clan'], [r.counts.banned, 'sospesi'], [r.counts.admins, 'amministratori'],
  ] as [number, string][]).map(([n, t]) => { const d = el('div', undefined, 'stat'); d.append(el('b', String(n)), el('span', t)); return d; }));

  const sel = $<HTMLSelectElement>('bcRoom');
  const prev = sel.value;
  sel.replaceChildren(Object.assign(el('option', 'tutte le stanze'), { value: '' }), ...r.rooms.map((x) => Object.assign(el('option', x.name), { value: x.name })));
  sel.value = r.rooms.some((x) => x.name === prev) ? prev : '';

  const box = $('rooms');
  if (!r.rooms.length) { box.replaceChildren(el('p', 'Nessuna stanza attiva.', 'muted')); return; }
  box.replaceChildren(...r.rooms.map((room) => {
    const card = el('div', undefined, 'room');
    const h = el('h3');
    const team = room.mode === 'tdm' || room.mode === 'ctf';
    const info = `${room.name} · ${MODE_NAMES[room.mode as GameMode] ?? room.mode} · livello ${room.level}${team ? ` · ${fmtTime(room.timeLeft)}` : ''}`;
    h.append(el('span', info), btn('Chiudi stanza', () => {
      const reason = prompt(`Chiudere "${room.name}" ed espellere tutti? Motivo (facoltativo):`, '');
      if (reason !== null) void act('close', { room: room.name, reason }, `Stanza ${room.name} chiusa`);
    }, 'act danger'));
    const t = el('table');
    t.appendChild(row(['Giocatore', 'Liv.', team ? 'Squadra' : 'Frag', 'Punti', 'Account', ''], true));
    for (const p of room.players) {
      const kick = btn('Espelli', () => {
        const reason = prompt(`Espellere ${p.name} dalla stanza? Motivo (facoltativo):`, '');
        if (reason !== null) void act('kick', { room: room.name, id: p.id, reason }, `${p.name} espulso`);
      }, 'act danger');
      t.appendChild(row([
        `${p.tag ? `[${p.tag}] ` : ''}${p.name}`, String(p.level), team ? (TEAMS[p.team]?.name ?? '–') : String(p.frags), String(p.score),
        p.userId === null ? 'ospite' : 'registrato', kick,
      ]));
    }
    const wrap = el('div', undefined, 'wrap');
    wrap.appendChild(t);
    card.append(h, wrap);
    return card;
  }));
}

$('bcForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $<HTMLInputElement>('bcText').value.trim();
  if (!text) return;
  const room = $<HTMLSelectElement>('bcRoom').value;
  void act('broadcast', { text, room: room || undefined }, 'Messaggio inviato').then(() => { $<HTMLInputElement>('bcText').value = ''; });
});

// ------------------------------------------------------------------ giocatori

interface UserRow { id: number; name: string; level: number; xp: number; tag: string; role: string; banned: string | null; created: number; frags: number; kills: number; captures: number; playtime: number; }

async function loadUsers(): Promise<void> {
  const q = $<HTMLInputElement>('userQ').value.trim();
  const r = await api<{ rows: UserRow[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`);
  const t = $('users');
  t.replaceChildren(row(['Giocatore', 'Liv.', 'EXP', 'Frag / nemici / catture', 'Iscritto', 'Stato', 'Azioni'], true));
  for (const u of r.rows) {
    const state = el('span', u.banned ? `sospeso: ${u.banned}` : u.role === 'admin' ? 'amministratore' : 'attivo', u.banned ? 'bad' : u.role === 'admin' ? 'good' : 'muted');
    const actions = el('span');
    actions.append(
      btn('Rinomina', () => {
        const n = prompt(`Nuovo nome per ${u.name} (3–16 caratteri tra lettere, cifre, _ e -):`, u.name);
        if (n && n !== u.name) void act('rename', { name: u.name, newName: n }, `${u.name} ora si chiama ${n}`);
      }),
      btn('EXP', () => {
        const v = prompt(`EXP di ${u.name} (ora ${u.xp}):`, String(u.xp));
        if (v !== null && v.trim() !== '') void act('stats', { name: u.name, op: 'xp', xp: Number(v) }, `EXP di ${u.name} corretta`);
      }),
      btn('Azzera', () => {
        if (confirm(`Azzerare EXP e tutte le statistiche di ${u.name}? Non si può annullare.`)) void act('stats', { name: u.name, op: 'reset' }, `Statistiche di ${u.name} azzerate`);
      }, 'act danger'),
    );
    if (u.banned) actions.append(btn('Riattiva', () => void act('unban', { name: u.name }, `${u.name} riattivato`)));
    else if (u.role !== 'admin') {
      actions.append(btn('Sospendi', () => {
        const reason = prompt(`Sospendere ${u.name}? Verrà disconnesso e non potrà più accedere. Motivo:`, '');
        if (reason !== null) void act('ban', { name: u.name, reason }, `${u.name} sospeso`);
      }, 'act danger'));
    }
    t.appendChild(row([
      `${u.tag ? `[${u.tag}] ` : ''}${u.name}`, String(u.level), String(u.xp), `${u.frags} / ${u.kills} / ${u.captures}`,
      new Date(u.created).toLocaleDateString('it-IT'), state, actions,
    ]));
  }
  if (!r.rows.length) t.appendChild(row(['Nessun giocatore trovato.']));
}

// ------------------------------------------------------------------ clan

async function loadClans(): Promise<void> {
  const q = $<HTMLInputElement>('clanQ').value.trim();
  const r = await api<{ rows: { tag: string; name: string; owner: string; members: number; created: number }[] }>(`/api/admin/clans?q=${encodeURIComponent(q)}`);
  const t = $('clans');
  t.replaceChildren(row(['Clan', 'Capo', 'Membri', 'Fondato', 'Azioni'], true));
  for (const c of r.rows) {
    const actions = el('span');
    actions.append(
      btn('Modifica', () => {
        const tag = prompt(`Nuova sigla per [${c.tag}] (2–4 lettere o cifre):`, c.tag);
        if (tag === null) return;
        const name = prompt(`Nuovo nome per [${c.tag}] (3–24 caratteri):`, c.name);
        if (name === null) return;
        void act('clan', { tag: c.tag, op: 'rename', newTag: tag, newName: name }, `Clan [${c.tag}] modificato`);
      }),
      btn('Sciogli', () => {
        const reason = prompt(`Sciogliere [${c.tag}] ${c.name}? I membri restano senza clan e lo storico delle sfide si perde. Motivo:`, '');
        if (reason !== null) void act('clan', { tag: c.tag, op: 'disband', reason }, `Clan [${c.tag}] sciolto`);
      }, 'act danger'),
    );
    t.appendChild(row([`[${c.tag}] ${c.name}`, c.owner, String(c.members), new Date(c.created).toLocaleDateString('it-IT'), actions]));
  }
  if (!r.rows.length) t.appendChild(row(['Nessun clan trovato.']));
}

// ------------------------------------------------------------------ registro

async function loadLog(): Promise<void> {
  const r = await api<{ rows: { ts: number; admin: string; action: string; target: string; detail: string }[] }>('/api/admin/log');
  const t = $('log');
  t.replaceChildren(row(['Quando', 'Chi', 'Azione', 'Su', 'Dettagli'], true));
  for (const x of r.rows) t.appendChild(row([fmtDate(x.ts), x.admin, x.action, x.target, x.detail]));
  if (!r.rows.length) t.appendChild(row(['Ancora nessuna azione registrata.']));
}

// ------------------------------------------------------------------ schede

let tab = 'server';
const loaders: Record<string, () => Promise<void>> = { server: loadServer, users: loadUsers, clans: loadClans, log: loadLog };
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs button')];
for (const b of tabs) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab!;
    for (const x of tabs) x.classList.toggle('on', x === b);
    for (const k of Object.keys(loaders)) $(`tab-${k}`).hidden = k !== tab;
    void refresh();
  });
}

async function refresh(): Promise<void> {
  try {
    await loaders[tab]();
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) { $('app').hidden = true; $('denied').hidden = false; return; }
    say((err as Error).message, false);
  }
}

let debounce = 0;
for (const id of ['userQ', 'clanQ']) {
  $(id).addEventListener('input', () => { clearTimeout(debounce); debounce = window.setTimeout(() => void refresh(), 250); });
}

async function start(): Promise<void> {
  try {
    await loadServer();
    $('app').hidden = false;
  } catch {
    $('denied').hidden = false;
    return;
  }
  // la scheda Server si aggiorna da sola; le altre su richiesta
  setInterval(() => { if (tab === 'server' && !document.hidden) void refresh(); }, 5000);
}
void start();
