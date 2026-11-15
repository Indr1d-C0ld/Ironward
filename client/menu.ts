// Menu iniziale: accesso/registrazione/ospite, profilo e personalizzazione,
// statistiche personali e classifiche.

import { GAME_MODES, MODE_NAMES, PLAYER_COLORS, parseMode, type GameMode } from '../shared/defs.ts';
import {
  CLAN_FOUND_LEVEL, CLAN_MAX_MEMBERS, COLOR_LEVELS, HATS, MAX_LEVEL, PERKS, colorUnlocked, hatUnlocked, unlocksAt, xpForLevel, type Profile,
} from '../shared/progression.ts';

interface ClanInfo {
  tag: string; name: string; created: number; owner: string;
  members: { name: string; level: number; color: number; owner: boolean; joined: number }[];
  stats: { xp: number; kills: number; frags: number; captures: number; wins: number };
  wars: { won: number; lost: number; drawn: number };
  recent: { ts: number; mode: string; vs: string; result: 'won' | 'lost' | 'drawn' }[];
  code?: string;
}

export interface PlayOptions {
  name: string;
  color: number;
  room: string;
  mode: GameMode;
  seed: string;
  token: string | null;
}

const TOKEN_KEY = 'iw-token';
const COLOR_NAMES = PLAYER_COLORS.map((c) => c.name);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null): void {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignora */ }
  },
};

let token: string | null = store.get(TOKEN_KEY);
let profile: Profile | null = null;

export function getToken(): string | null { return token; }
export function clearToken(): void { token = null; store.set(TOKEN_KEY, null); }

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

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function initMenu(onPlay: (o: PlayOptions) => void): void {
  const authBox = $('auth'), profBox = $('profile');
  const authForm = $<HTMLFormElement>('authForm');
  const authName = $<HTMLInputElement>('authName'), authPass = $<HTMLInputElement>('authPass');
  const authSubmit = $<HTMLButtonElement>('authSubmit'), authErr = $('authErr');
  const guestBox = $('guestBox'), guestName = $<HTMLInputElement>('guestName'), guestColor = $<HTMLSelectElement>('guestColor');
  const pColor = $<HTMLSelectElement>('pColor'), pHat = $<HTMLSelectElement>('pHat'), pClan = $<HTMLButtonElement>('pClan');
  const roomIn = $<HTMLInputElement>('room'), modeIn = $<HTMLSelectElement>('mode'), seedIn = $<HTMLInputElement>('seed');
  const panel = $('panel'), panelBody = $('panelBody'), panelTitle = $('panelTitle');
  let tab: 'login' | 'register' | 'guest' = 'login';

  // --- schede di accesso
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#auth .tabs button')];
  const setTab = (t: typeof tab) => {
    tab = t;
    for (const b of tabs) b.classList.toggle('on', b.dataset.tab === t);
    authForm.hidden = t === 'guest';
    guestBox.hidden = t !== 'guest';
    authSubmit.textContent = t === 'login' ? 'Accedi' : 'Crea account';
    authPass.autocomplete = t === 'login' ? 'current-password' : 'new-password';
    authErr.textContent = '';
  };
  for (const b of tabs) b.addEventListener('click', () => setTab(b.dataset.tab as typeof tab));

  PLAYER_COLORS.forEach((c, i) => {
    if (COLOR_LEVELS[i] > 1) return;
    const o = el('option', c.name);
    o.value = String(i);
    guestColor.appendChild(o);
  });
  guestName.value = store.get('iw-name') ?? '';
  guestColor.value = store.get('iw-color') ?? '0';
  if (!guestColor.value) guestColor.value = '0';

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authErr.textContent = '';
    authSubmit.disabled = true;
    try {
      const path = tab === 'register' ? '/api/register' : '/api/login';
      const r = await api<{ token: string; profile: Profile }>(path, { name: authName.value.trim(), password: authPass.value, color: Number(guestColor.value) });
      token = r.token;
      store.set(TOKEN_KEY, token);
      authPass.value = '';
      showProfile(r.profile);
    } catch (err) {
      authErr.textContent = (err as Error).message;
    } finally {
      authSubmit.disabled = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch { /* ignora */ }
    clearToken();
    profile = null;
    $('adminLink').hidden = true;
    profBox.hidden = true;
    authBox.hidden = false;
  });

  // --- profilo e personalizzazione
  function showProfile(p: Profile): void {
    profile = p;
    authBox.hidden = true;
    profBox.hidden = false;
    $('pName').textContent = p.name;
    $('adminLink').hidden = !p.admin;
    $('pTagShow').textContent = p.tag ? `[${p.tag}] ` : '';
    $('pLevel').textContent = String(p.level);
    const cur = xpForLevel(p.level), next = xpForLevel(p.level + 1);
    const frac = p.level >= MAX_LEVEL ? 1 : (p.xp - cur) / (next - cur);
    $('pXpFill').style.width = `${Math.round(frac * 100)}%`;
    $('pXpText').textContent = p.level >= MAX_LEVEL ? `${p.xp} EXP · livello massimo` : `${p.xp - cur} / ${next - cur} EXP verso il livello ${p.level + 1}`;

    pColor.replaceChildren(...PLAYER_COLORS.map((c, i) => {
      const ok = colorUnlocked(i, p.level);
      const o = el('option', ok ? c.name : `${c.name} (liv. ${COLOR_LEVELS[i]})`);
      o.value = String(i);
      o.disabled = !ok;
      return o;
    }));
    pColor.value = String(p.color);
    pHat.replaceChildren(...HATS.map((h, i) => {
      const ok = hatUnlocked(i, p.level);
      const o = el('option', ok ? h.name : `${h.name} (liv. ${h.level})`);
      o.value = String(i);
      o.disabled = !ok;
      return o;
    }));
    pHat.value = String(p.hat);
    pClan.textContent = p.clan ? `[${p.clan.tag}]` : 'Nessuno';
    pClan.title = p.clan ? p.clan.name : 'Entra in un clan o fondane uno';

    let nextText = '';
    for (let l = p.level + 1; l <= MAX_LEVEL; l++) {
      const u = unlocksAt(l, COLOR_NAMES);
      if (u.length) { nextText = `Al livello ${l}: ${u.join(', ')}`; break; }
    }
    const active = PERKS.filter((k) => k.level <= p.level).map((k) => k.name);
    $('pNext').textContent = [nextText, active.length ? `Bonus attivi in cooperativa: ${active.join(', ')}` : ''].filter(Boolean).join(' · ');
  }

  const saveCosmetics = async () => {
    if (!profile) return;
    $('pErr').textContent = '';
    try {
      const r = await api<{ profile: Profile }>('/api/profile', { color: Number(pColor.value), hat: Number(pHat.value) });
      showProfile(r.profile);
    } catch (err) {
      $('pErr').textContent = (err as Error).message;
    }
  };
  pColor.addEventListener('change', saveCosmetics);
  pHat.addEventListener('change', saveCosmetics);

  // --- pannelli statistiche e classifica
  const openPanel = (title: string) => { panelTitle.textContent = title; panelBody.replaceChildren(); panel.hidden = false; };
  $('panelClose').addEventListener('click', () => { panel.hidden = true; });

  $('openStats').addEventListener('click', async () => {
    if (!profile) {
      openPanel('Statistiche');
      panelBody.appendChild(el('p', 'Accedi o crea un account per salvare statistiche ed esperienza.', 'hint'));
      return;
    }
    try { showProfile((await api<{ profile: Profile }>('/api/me')).profile); } catch { /* usa la copia locale */ }
    const p = profile;
    const s = p.stats;
    openPanel(`Statistiche di ${p.name}`);
    const kd = s.deaths ? (s.frags + s.kills) / s.deaths : s.frags + s.kills;
    const rows: [string, string][] = [
      ['Livello', `${p.level} (${p.xp} EXP)`],
      ['Nemici eliminati', String(s.kills)],
      ['Frag (deathmatch)', String(s.frags)],
      ['Morti', String(s.deaths)],
      ['Eliminazioni / morti', kd.toFixed(2)],
      ['Precisione', s.shots ? `${Math.round((s.hits / s.shots) * 100)}% (${s.hits}/${s.shots})` : '–'],
      ['Danni inflitti', String(s.damage)],
      ['Livelli completati', String(s.exits)],
      ['Partite vinte', `${s.wins} su ${s.matches} completate`],
      ['Documenti catturati', String(s.captures)],
      ['Passaggi segreti', String(s.secrets)],
      ['Tesori', String(s.treasure)],
      ['Serie migliore', String(s.bestStreak)],
      ['Punteggio migliore', String(s.bestScore)],
      ['Tempo di gioco', fmtTime(s.playtime)],
      ['Iscritto dal', new Date(p.created).toLocaleDateString('it-IT')],
    ];
    const table = el('table', undefined, 'stats');
    for (const [k, v] of rows) {
      const tr = el('tr');
      tr.append(el('th', k), el('td', v));
      table.appendChild(tr);
    }
    panelBody.appendChild(table);
  });

  // --- clan
  const button = (text: string, onClick: () => void, cls = 'mini') => {
    const b = el('button', text, cls);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const colorDot = (c: number) => {
    const dot = el('span', undefined, 'dot');
    dot.style.background = `rgb(${PLAYER_COLORS[c]?.rgb.join(',') ?? '128,128,128'})`;
    return dot;
  };
  const clanAction = async (action: string, body: Record<string, unknown>, errBox: HTMLElement) => {
    errBox.textContent = '';
    try {
      const r = await api<{ profile: Profile; clan: ClanInfo | null; code?: string }>(`/api/clan/${action}`, body);
      showProfile(r.profile);
      renderClanPanel(r.clan);
    } catch (err) {
      errBox.textContent = (err as Error).message;
    }
  };

  /** Pannello del clan: il proprio (con gestione) oppure quello di un altro, in sola lettura. */
  function renderClanPanel(info: ClanInfo | null): void {
    const mine = !!(profile?.clan && info && profile.clan.tag === info.tag);
    openPanel(info ? `[${info.tag}] ${info.name}` : 'Clan');
    const errBox = el('p', undefined, 'err');
    errBox.setAttribute('role', 'alert');

    if (!info) {
      if (!profile) { panelBody.appendChild(el('p', 'Accedi o crea un account per entrare in un clan.', 'hint')); return; }
      panelBody.appendChild(el('p', 'I membri di un clan portano la stessa sigla, giocano nella stessa squadra e sommano i loro risultati nella classifica dei clan. Quando due clan si affrontano da soli in una partita a squadre, la sfida finisce nello storico.', 'hint'));
      panelBody.appendChild(el('h3', 'Entra con un codice d’invito'));
      const code = el('input');
      code.maxLength = 12; code.placeholder = 'Codice'; code.autocomplete = 'off';
      const joinRow = el('div', undefined, 'row2');
      joinRow.style.gridTemplateColumns = '1fr 90px';
      joinRow.append(code, button('Entra', () => void clanAction('join', { code: code.value }, errBox), 'secondary'));
      (joinRow.lastElementChild as HTMLElement).style.margin = '0';
      panelBody.appendChild(joinRow);

      panelBody.appendChild(el('h3', 'Fonda un clan'));
      if (profile.level < CLAN_FOUND_LEVEL) {
        panelBody.appendChild(el('p', `Si sblocca al livello ${CLAN_FOUND_LEVEL}.`, 'hint'));
      } else {
        const row = el('div', undefined, 'row2');
        const tag = el('input'); tag.maxLength = 4; tag.placeholder = 'Sigla'; tag.autocomplete = 'off';
        tag.addEventListener('input', () => { tag.value = tag.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
        const name = el('input'); name.maxLength = 24; name.placeholder = 'Nome del clan'; name.autocomplete = 'off';
        row.append(tag, name);
        panelBody.append(row, button('Fonda il clan', () => void clanAction('create', { tag: tag.value, name: name.value }, errBox), 'secondary'));
        panelBody.appendChild(el('p', `Sigla di 2–4 lettere o cifre, nome di 3–24 caratteri. Fino a ${CLAN_MAX_MEMBERS} membri.`, 'hint'));
      }
      panelBody.appendChild(errBox);
      return;
    }

    panelBody.appendChild(el('p', `Capo: ${info.owner} · fondato il ${new Date(info.created).toLocaleDateString('it-IT')} · ${info.members.length}/${CLAN_MAX_MEMBERS} membri`, 'hint'));
    const w = info.wars;
    const stats: [string, string][] = [
      ['EXP guadagnata', String(info.stats.xp)],
      ['Frag', String(info.stats.frags)],
      ['Nemici eliminati', String(info.stats.kills)],
      ['Documenti catturati', String(info.stats.captures)],
      ['Vittorie di squadra', String(info.stats.wins)],
      ['Sfide tra clan', `${w.won} vinte · ${w.lost} perse · ${w.drawn} pari`],
    ];
    const st = el('table', undefined, 'stats');
    for (const [k, v] of stats) { const tr = el('tr'); tr.append(el('th', k), el('td', v)); st.appendChild(tr); }
    panelBody.append(st, el('p', 'Contano i risultati ottenuti dai membri da quando sono nel clan.', 'hint'));

    if (mine && info.code) {
      panelBody.appendChild(el('h3', 'Codice d’invito'));
      const row = el('div');
      const codeEl = el('span', info.code, 'code');
      row.append(codeEl, button('Copia', () => { void navigator.clipboard?.writeText(info.code!).catch(() => undefined); }));
      if (profile?.clan?.owner) row.appendChild(button('Nuovo codice', () => void clanAction('code', {}, errBox)));
      panelBody.append(row, el('p', 'Chi ha il codice può entrare nel clan. Generarne uno nuovo invalida il precedente.', 'hint'));
    }

    panelBody.appendChild(el('h3', 'Membri'));
    const mt = el('table', undefined, 'board plain');
    const head = el('tr');
    head.append(el('th', 'Giocatore'), el('th', 'Liv.'), el('th', ''));
    mt.appendChild(head);
    for (const m of info.members) {
      const tr = el('tr');
      if (profile && m.name === profile.name) tr.className = 'me';
      const nameTd = el('td');
      nameTd.append(colorDot(m.color), document.createTextNode(m.name + (m.owner ? ' ★' : '')));
      const act = el('td');
      act.style.textAlign = 'right';
      if (mine && profile?.clan?.owner && !m.owner) {
        act.append(
          button('Capo', () => { if (confirm(`Cedere il comando del clan a ${m.name}?`)) void clanAction('transfer', { name: m.name }, errBox); }),
          button('Allontana', () => { if (confirm(`Allontanare ${m.name} dal clan?`)) void clanAction('kick', { name: m.name }, errBox); }, 'mini danger'),
        );
      }
      tr.append(nameTd, el('td', String(m.level)), act);
      mt.appendChild(tr);
    }
    panelBody.appendChild(mt);

    if (info.recent.length) {
      panelBody.appendChild(el('h3', 'Ultime sfide'));
      const rt = el('table', undefined, 'board plain');
      const label = { won: 'Vinta', lost: 'Persa', drawn: 'Pareggio' } as const;
      for (const m of info.recent) {
        const tr = el('tr');
        tr.append(el('td', new Date(m.ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })), el('td', `contro [${m.vs}]`), el('td', MODE_NAMES[m.mode as GameMode] ?? m.mode), el('td', label[m.result], m.result));
        rt.appendChild(tr);
      }
      panelBody.appendChild(rt);
    }

    if (mine) {
      const last = info.members.length === 1;
      panelBody.appendChild(button(last ? 'Sciogli il clan' : 'Esci dal clan', () => {
        const q = last ? 'Sei l’ultimo membro: uscendo il clan e il suo storico verranno cancellati. Continuare?'
          : profile?.clan?.owner ? 'Uscendo, il comando passa al membro con più EXP. Continuare?' : 'Uscire dal clan?';
        if (confirm(q)) void clanAction('leave', {}, errBox);
      }, 'secondary'));
    }
    panelBody.appendChild(errBox);
  }

  const openClan = async (tag: string | null) => {
    if (!tag) { renderClanPanel(null); return; }
    openPanel(`[${tag}]`);
    panelBody.appendChild(el('p', 'Caricamento…', 'hint'));
    try {
      renderClanPanel((await api<{ clan: ClanInfo }>(`/api/clan/${encodeURIComponent(tag)}`)).clan);
    } catch (err) {
      panelBody.replaceChildren(el('p', (err as Error).message, 'hint'));
    }
  };
  pClan.addEventListener('click', () => void openClan(profile?.clan?.tag ?? null));

  $('openBoard').addEventListener('click', () => {
    openPanel('Classifica');
    const controls = el('div', undefined, 'row3 even');
    const kind = el('select');
    for (const [v, t] of [['players', 'Giocatori'], ['clans', 'Clan']]) { const o = el('option', t); o.value = v; kind.appendChild(o); }
    const by = el('select');
    const setBy = () => {
      const opts = kind.value === 'clans'
        ? [['xp', 'Esperienza'], ['frags', 'Frag'], ['captures', 'Catture'], ['wars', 'Sfide vinte']]
        : [['xp', 'Esperienza'], ['frags', 'Frag'], ['kills', 'Nemici eliminati'], ['captures', 'Catture']];
      const prev = by.value;
      by.replaceChildren(...opts.map(([v, t]) => { const o = el('option', t); o.value = v; return o; }));
      if (opts.some(([v]) => v === prev)) by.value = prev;
    };
    setBy();
    const period = el('select');
    for (const [v, t] of [['all', 'Sempre'], ['week', 'Ultimi 7 giorni']]) { const o = el('option', t); o.value = v; period.appendChild(o); }
    controls.append(kind, by, period);
    const out = el('div');
    panelBody.append(controls, out);
    const load = async () => {
      out.replaceChildren(el('p', 'Caricamento…', 'hint'));
      try {
        if (kind.value === 'clans') {
          const r = await api<{ rows: { tag: string; name: string; members: number; value: number }[] }>(`/api/clans?by=${by.value}&period=${period.value}`);
          if (!r.rows.length) { out.replaceChildren(el('p', 'Ancora nessun clan in classifica.', 'hint')); return; }
          const table = el('table', undefined, 'board');
          const head = el('tr');
          head.append(el('th', '#'), el('th', 'Clan'), el('th', 'Membri'), el('th', by.selectedOptions[0].textContent ?? ''));
          table.appendChild(head);
          r.rows.forEach((row, i) => {
            const tr = el('tr', undefined, 'click');
            if (profile?.clan?.tag === row.tag) tr.classList.add('me');
            tr.append(el('td', String(i + 1)), el('td', `[${row.tag}] ${row.name}`), el('td', String(row.members)), el('td', String(row.value)));
            tr.addEventListener('click', () => void openClan(row.tag));
            table.appendChild(tr);
          });
          out.replaceChildren(table);
          return;
        }
        const r = await api<{ rows: { name: string; tag: string; level: number; color: number; value: number }[] }>(`/api/leaderboard?by=${by.value}&period=${period.value}`);
        if (!r.rows.length) { out.replaceChildren(el('p', 'Ancora nessun risultato.', 'hint')); return; }
        const table = el('table', undefined, 'board');
        const head = el('tr');
        head.append(el('th', '#'), el('th', 'Giocatore'), el('th', 'Liv.'), el('th', by.selectedOptions[0].textContent ?? ''));
        table.appendChild(head);
        r.rows.forEach((row, i) => {
          const tr = el('tr');
          if (profile && row.name === profile.name) tr.className = 'me';
          const nameTd = el('td');
          const dot = el('span', undefined, 'dot');
          dot.style.background = `rgb(${PLAYER_COLORS[row.color]?.rgb.join(',') ?? '128,128,128'})`;
          nameTd.append(dot, document.createTextNode(`${row.tag ? `[${row.tag}] ` : ''}${row.name}`));
          tr.append(el('td', String(i + 1)), nameTd, el('td', String(row.level)), el('td', String(row.value)));
          table.appendChild(tr);
        });
        out.replaceChildren(table);
      } catch (err) {
        out.replaceChildren(el('p', (err as Error).message, 'hint'));
      }
    };
    kind.addEventListener('change', () => { setBy(); void load(); });
    by.addEventListener('change', load);
    period.addEventListener('change', load);
    void load();
  });

  // --- stanza e avvio
  const params = new URLSearchParams(location.search);
  roomIn.value = params.get('room') ?? 'lobby';
  modeIn.replaceChildren(...GAME_MODES.map((m) => { const o = el('option', MODE_NAMES[m]); o.value = m; return o; }));
  modeIn.value = parseMode(params.get('mode'));
  if (params.get('seed')) seedIn.value = params.get('seed')!;

  $<HTMLFormElement>('join').addEventListener('submit', (e) => {
    e.preventDefault();
    store.set('iw-name', guestName.value);
    store.set('iw-color', guestColor.value);
    onPlay({
      name: profile ? profile.name : guestName.value.trim() || authName.value.trim() || 'Recluta',
      color: profile ? profile.color : Number(guestColor.value),
      room: roomIn.value,
      mode: modeIn.value as GameMode,
      seed: seedIn.value,
      token: profile ? token : null,
    });
  });

  setTab('login');
  if (token) {
    api<{ profile: Profile }>('/api/me')
      .then((r) => showProfile(r.profile))
      .catch((err: Error & { status?: number }) => { if (err.status === 401) clearToken(); });
  }
}
