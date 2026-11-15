// Test della simulazione del server senza rete: PvP in deathmatch, IA dei nemici
// in cooperativa, porte e raccolta oggetti.
// Uso: node tools/test-room.ts

import type { WebSocket } from 'ws';
import { ES_DEAD, ES_IDLE, TICK_DT } from '../shared/defs.ts';
import type { InputCmd } from '../shared/protocol.ts';
import { FLAG_CARRIED, FLAG_HOME, Room, type SPlayer } from '../server/room.ts';
import { XP_CAPTURE, XP_ENEMY, XP_FRAG, type StatDelta } from '../shared/progression.ts';
import { CTF_LIMIT, TDM_LIMIT } from '../shared/defs.ts';

const fakeWs = () => ({ readyState: 1, send() {} }) as unknown as WebSocket;
const guest = (name: string, color: number) => ({ name, color, hat: 0, tag: '', userId: null, xp: 0 });
let failed = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

function cmds(p: SPlayer, n: number, c: Partial<InputCmd>): InputCmd[] {
  const out: InputCmd[] = [];
  for (let i = 0; i < n; i++) out.push({ q: p.lastSeq + 1 + i, f: 0, s: 0, a: p.a, b: 0, w: -1, ...c });
  return out;
}

function run(room: Room, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += TICK_DT) { each?.(); room.update(TICK_DT); }
}

// --- Deathmatch: due giocatori nella stessa stanza, A spara a B.
{
  const room = new Room('t-dm', 'dm', 4242);
  const a = room.addPlayer(1, fakeWs(), guest('A', 0));
  const b = room.addPlayer(2, fakeWs(), guest('B', 1));
  const rm = room.level.rooms.find((r) => r.w >= 6)!;
  a.x = rm.x + 0.5; a.y = rm.y + 0.5;
  b.x = rm.x + 4.5; b.y = rm.y + 0.5;
  a.a = 0;
  a.ammo = 99;
  run(room, 4, () => room.enqueue(a, cmds(a, 2, { b: 1, a: 0 })));
  ok(b.deaths >= 1, `dm: B eliminato da A (morti B=${b.deaths}, frag A=${a.frags})`);
  ok(a.frags >= 1, 'dm: frag assegnato ad A');
  ok(a.ammo < 99, `dm: munizioni consumate (${a.ammo})`);
  ok(a.delta.xp >= XP_FRAG * a.frags, `dm: EXP per i frag (${a.delta.xp})`);
  ok(a.delta.shots > 0 && a.delta.hits > 0 && a.delta.hits <= a.delta.shots, `dm: colpi ${a.delta.hits}/${a.delta.shots}`);
  ok(b.delta.deaths === b.deaths, 'dm: morti registrate');
}

// --- Cooperativa: un nemico si sveglia vedendo il giocatore, attacca, e muore se colpito.
{
  const room = new Room('t-coop', 'coop', 777);
  const p = room.addPlayer(1, fakeWs(), guest('P', 0));
  const e = room.enemies.find((x) => x.kind === 'guard')!;
  // giocatore nella stessa cella-stanza del nemico, 3 celle più in là con vista libera
  const rm = room.level.rooms.find((r) => e.x >= r.x && e.x < r.x + r.w && e.y >= r.y && e.y < r.y + r.h)!;
  const cand: [number, number][] = [];
  for (let y = rm.y; y < rm.y + rm.h; y++) for (let x = rm.x; x < rm.x + rm.w; x++) cand.push([x + 0.5, y + 0.5]);
  cand.sort((u, v) => Math.abs(Math.hypot(u[0] - e.x, u[1] - e.y) - 3) - Math.abs(Math.hypot(v[0] - e.x, v[1] - e.y) - 3));
  [p.x, p.y] = cand[0];
  e.a = Math.atan2(p.y - e.y, p.x - e.x);
  // nessun altro nemico deve disturbare il test
  for (const o of room.enemies) if (o !== e) o.state = ES_DEAD;
  run(room, 4);
  ok(e.state !== ES_IDLE, `coop: il nemico si è svegliato (stato ${e.state})`);
  ok(p.hp < 100 || p.deaths > 0, `coop: il nemico ha colpito il giocatore (hp ${p.hp})`);
  p.hp = 100; p.ammo = 99;
  const aim = () => { p.a = Math.atan2(e.y - p.y, e.x - p.x); room.enqueue(p, cmds(p, 2, { b: 1, a: p.a })); };
  run(room, 3, aim);
  ok(e.state === ES_DEAD, `coop: nemico ucciso (hp ${e.hp})`);
  ok(p.score >= 100, `coop: punti assegnati (${p.score})`);
  ok(room.dynItems.length > 0, 'coop: il nemico lascia un caricatore');
  ok(p.delta.kills === 1 && p.delta.xp >= XP_ENEMY.guard, `coop: EXP per il nemico (${p.delta.xp})`);
}

// --- Salvataggio: un giocatore registrato passa le statistiche all'hook e sale di livello.
{
  const saved: { uid: number; d: StatDelta }[] = [];
  const room = new Room('t-flush', 'coop', 31337, { flush: (uid, d) => saved.push({ uid, d: { ...d } }) });
  const p = room.addPlayer(1, fakeWs(), { name: 'Reg', color: 0, hat: 0, tag: 'T', userId: 42, xp: 95 });
  const g = room.addPlayer(2, fakeWs(), guest('Ospite', 1));
  ok(p.level === 1, 'flush: livello iniziale da EXP salvata');
  const e = room.enemies.find((x) => x.kind === 'trooper') ?? room.enemies[0];
  e.hp = 1;
  p.x = e.x - 2; p.y = e.y; p.a = 0;
  // danno diretto al nemico, senza passare dalla mira
  (room as unknown as { damageEnemy(e: unknown, d: number, by: SPlayer): void }).damageEnemy(e, 10, p);
  room.update(TICK_DT);
  ok(p.level === 2, `flush: passaggio di livello in partita (EXP ${room.xpOf(p)})`);
  room.removePlayer(p.id);
  room.removePlayer(g.id);
  ok(saved.length === 1 && saved[0].uid === 42, 'flush: salvato solo il giocatore registrato');
  ok(saved[0]?.d.kills === 1 && saved[0].d.xp > 0 && saved[0].d.playtime >= 0, 'flush: statistiche passate al database');
}

// --- Porte: E davanti a una porta la apre, poi si richiude da sola.
{
  const room = new Room('t-door', 'coop', 999);
  const p = room.addPlayer(1, fakeWs(), guest('P', 0));
  for (const o of room.enemies) o.state = ES_DEAD;
  const d = room.level.doors.find((x) => !x.secret)!;
  // davanti alla porta, sul lato libero, guardando la porta
  if (d.ew) { p.x = d.x - 0.5; p.y = d.y + 0.5; p.a = 0; } else { p.x = d.x + 0.5; p.y = d.y - 0.5; p.a = Math.PI / 2; }
  room.enqueue(p, cmds(p, 1, { b: 2, a: p.a }));
  run(room, 1);
  ok(room.doorOpen[d.id] >= 1, `porta: aperta (${room.doorOpen[d.id].toFixed(2)})`);
  run(room, 6);
  ok(room.doorOpen[d.id] === 0, `porta: richiusa (${room.doorOpen[d.id].toFixed(2)})`);
}

// --- Deathmatch a squadre: bilanciamento, sigla, niente fuoco amico, punteggio di squadra.
{
  const room = new Room('t-tdm', 'tdm', 2024);
  const a = room.addPlayer(1, fakeWs(), { ...guest('A', 0), tag: 'XX' });
  const b = room.addPlayer(2, fakeWs(), { ...guest('B', 0), tag: 'XX' });
  const c = room.addPlayer(3, fakeWs(), guest('C', 0));
  const d = room.addPlayer(4, fakeWs(), { ...guest('D', 0), tag: 'XX' });
  const sizes = [0, 1].map((t) => [a, b, c, d].filter((p) => p.team === t).length);
  ok(sizes[0] === 2 && sizes[1] === 2, `tdm: squadre bilanciate (${sizes})`);
  ok(d.team === a.team || d.team === b.team, 'tdm: a parità si raggiunge la propria sigla');
  const mate = [b, c, d].find((p) => p.team === a.team)!;
  const foe = [b, c, d].find((p) => p.team !== a.team)!;
  ok(room.level.teamSpawns[a.team].some((s) => s.x === a.x && s.y === a.y), 'tdm: spawn vicino alla propria base');
  const rm = room.level.rooms.find((r) => r.w >= 7)!;
  for (const p of [a, b, c, d]) { p.x = rm.x + 6.5; p.y = rm.y + 0.5; }
  a.x = rm.x + 0.5; a.a = 0; a.ammo = 99;
  mate.x = rm.x + 2.5; foe.x = rm.x + 4.5;
  run(room, 3, () => room.enqueue(a, cmds(a, 2, { b: 1, a: 0 })));
  ok(mate.hp === 100 && mate.deaths === 0, 'tdm: il compagno non subisce danni e non blocca i colpi');
  ok(foe.deaths >= 1 && room.teamScore[a.team] >= 1, `tdm: punto alla squadra (${room.teamScore})`);
  room.teamScore[a.team] = TDM_LIMIT - 1;
  foe.alive = true; foe.hp = 1; foe.x = rm.x + 4.5; foe.y = rm.y + 0.5;
  run(room, 1, () => room.enqueue(a, cmds(a, 2, { b: 1, a: 0 })));
  ok(room.pendingLevel > 0 && a.delta.wins === 1 && foe.delta.wins === 0, 'tdm: vittoria al limite di frag');
  run(room, 7);
  ok(room.teamScore[0] === 0 && room.teamScore[1] === 0 && room.levelNum === 2, 'tdm: nuova partita');
}

// --- Compensazione della latenza: il colpo vale dove il tiratore vedeva il bersaglio.
{
  const room = new Room('t-lag', 'dm', 4242);
  const a = room.addPlayer(1, fakeWs(), guest('A', 0));
  const b = room.addPlayer(2, fakeWs(), guest('B', 1));
  const rm = room.level.rooms.find((r) => r.w >= 7 && r.h >= 5)!;
  const y0 = rm.y + 0.5;
  a.x = rm.x + 0.5; a.y = y0; a.a = 0; a.ammo = 99; a.weapon = 1; a.weapons[1] = true;
  b.x = rm.x + 5.5; b.y = y0;
  run(room, 0.3);
  const seen = room.tick; // A vede B sulla linea di tiro
  // B si sposta di lato di una cella (fuori dalla linea di tiro) in due tick
  b.y = y0 + 0.5; run(room, TICK_DT);
  b.y = y0 + 1; run(room, TICK_DT);
  const hp0 = b.hp;
  room.enqueue(a, cmds(a, 1, { b: 1, a: 0 }));
  run(room, TICK_DT);
  ok(b.hp === hp0, 'latenza: senza indicazione del tick il colpo manca chi si è spostato');
  a.cooldown = 0;
  room.enqueue(a, cmds(a, 1, { b: 1, a: 0, v: seen }));
  run(room, TICK_DT);
  ok(b.hp < hp0, `latenza: con il tick visto dal tiratore il colpo va a segno (${hp0} → ${b.hp})`);
  run(room, 1); // ora B è fuori linea da più di 400 ms
  const hp1 = b.hp;
  a.cooldown = 0;
  room.enqueue(a, cmds(a, 1, { b: 1, a: 0, v: room.tick - 100 }));
  run(room, TICK_DT);
  ok(b.hp === hp1, 'latenza: oltre 400 ms non si riavvolge');
}

// --- Giubbotto, granate, tessera e porte blindate.
{
  // giubbotto: l'armatura assorbe metà dei danni
  const room = new Room('t-gear', 'dm', 4242);
  const a = room.addPlayer(1, fakeWs(), guest('A', 0));
  const b = room.addPlayer(2, fakeWs(), guest('B', 1));
  b.armor = 50; b.hp = 100;
  room['damagePlayer'](b, 40, a, null);
  ok(b.hp === 80 && b.armor === 30, `giubbotto: 40 danni → salute ${b.hp}, armatura ${b.armor}`);
  ok(room['tryPickup'](b, 'vest') && b.armor === 80 && room['tryPickup'](b, 'grenade') && b.grenades >= 2, 'giubbotto e granate raccolti');

  // granata: esplode dopo la miccia, ferisce gli avversari vicini
  const rm = room.level.rooms.find((r) => r.w >= 7 && r.h >= 5)!;
  a.x = rm.x + 0.5; a.y = rm.y + 2.5; a.a = 0; a.grenades = 1; a.armor = 0;
  b.x = rm.x + 4.5; b.y = rm.y + 2.5; b.hp = 100; b.armor = 0; b.alive = true;
  room.enqueue(a, cmds(a, 1, { b: 4, a: 0 }));
  run(room, 0.2);
  ok(a.grenades === 0 && room.grenades.length === 1, 'granata lanciata');
  run(room, 2);
  ok(room.grenades.length === 0 && b.hp < 100, `granata esplosa: ferito chi era vicino (salute ${b.hp})`);

  // cooperativa: niente danni ai compagni; tessera e porte blindate
  let seed = 1;
  let co = new Room('t-key', 'coop', seed);
  while (!co.level.doors.some((d) => d.locked)) co = new Room('t-key', 'coop', ++seed);
  const p1 = co.addPlayer(1, fakeWs(), guest('P1', 0));
  const p2 = co.addPlayer(2, fakeWs(), guest('P2', 1));
  p2.x = p1.x + 1; p2.y = p1.y; p1.grenades = 1;
  co['explode']({ x: p1.x + 0.5, y: p1.y, vx: 0, vy: 0, fuse: 0, owner: p1.id });
  ok(p2.hp === 100 && p1.hp < 100, `granata in cooperativa: compagno illeso, lanciatore ferito (${p1.hp})`);
  const di = co.level.doors.findIndex((d) => d.locked);
  const door = co.level.doors[di];
  // davanti alla porta, guardandola
  const cand: [number, number][] = door.ew ? [[door.x - 1, door.y], [door.x + 1, door.y]] : [[door.x, door.y - 1], [door.x, door.y + 1]];
  const [fx, fy] = cand.find(([x, y]) => co.level.walls[y * co.level.w + x] === 0)!;
  p1.x = fx + 0.5; p1.y = fy + 0.5; p1.a = Math.atan2(door.y - fy, door.x - fx); p1.hp = 100;
  room['events'].length = 0;
  co.enqueue(p1, cmds(p1, 1, { b: 2, a: p1.a }));
  run(co, 0.1);
  ok(co.doorOpen[di] === 0, 'porta blindata: senza tessera resta chiusa');
  const ki = co.level.items.findIndex((it) => it.kind === 'key');
  p2.x = co.level.items[ki].x; p2.y = co.level.items[ki].y;
  run(co, 0.1);
  ok(co.hasKey, 'tessera raccolta');
  co.enqueue(p1, cmds(p1, 1, { b: 0, a: p1.a }));
  co.enqueue(p1, cmds(p1, 1, { b: 2, a: p1.a }));
  run(co, 1);
  ok(co.doorOpen[di] > 0, 'porta blindata: con la tessera si apre');
}

// --- Clan: squadre composte per clan a inizio partita e sfida tra clan registrata.
{
  const wars: string[] = [];
  const room = new Room('t-clan', 'tdm', 77, { clanMatch: (m, a, b, w) => wars.push(`${m}:${a}-${b}:${w}`) });
  const mk = (id: number, tag: string) => room.addPlayer(id, fakeWs(), { ...guest(`P${id}`, 0), tag, userId: id });
  const ps = [mk(1, 'AA'), mk(2, 'BB'), mk(3, 'BB'), mk(4, 'AA'), mk(5, 'AA'), mk(6, 'BB')];
  room['endMatch'](0);
  ok(wars.length === 0 || wars.length === 1, 'clan: esito registrato solo con squadre di un solo clan');
  wars.length = 0;
  run(room, 7);
  const tA = ps[0].team, tB = ps[1].team;
  ok(tA !== tB && ps.every((p) => p.team === (p.tag === 'AA' ? tA : tB)), 'clan: a inizio partita ogni clan in una squadra');
  room['endMatch'](tB);
  ok(wars.length === 1 && wars[0] === (tA === 0 ? 'tdm:AA-BB:BB' : 'tdm:BB-AA:BB'), `clan: sfida registrata (${wars})`);
  // Un clan da solo in una stanza con ospiti: squadre comunque bilanciate.
  const room2 = new Room('t-clan2', 'tdm', 78);
  const qs = [1, 2, 3, 4].map((id) => room2.addPlayer(id, fakeWs(), { ...guest(`Q${id}`, 0), tag: 'CC', userId: id }));
  qs.push(room2.addPlayer(5, fakeWs(), guest('G5', 0)), room2.addPlayer(6, fakeWs(), guest('G6', 0)));
  room2['endMatch'](-1);
  run(room2, 7);
  const n0 = qs.filter((p) => p.team === 0).length;
  ok(n0 === 3, `clan: squadre bilanciate anche con un clan numeroso (${n0} contro ${6 - n0})`);
}

// --- Cattura i documenti: presa, caduta alla morte, recupero, cattura, vittoria.
{
  const room = new Room('t-ctf', 'ctf', 555);
  const a = room.addPlayer(1, fakeWs(), guest('A', 0));
  const b = room.addPlayer(2, fakeWs(), guest('B', 0));
  ok(a.team !== b.team && room.flags.length === 2, 'ctf: due squadre e due valigette');
  const enemyFlag = room.flags[1 - a.team], ownFlag = room.flags[a.team];
  const freeze = () => { for (const p of [a, b]) p.queue.length = 0; };
  a.x = enemyFlag.homeX; a.y = enemyFlag.homeY;
  b.x = ownFlag.homeX + 30; b.y = ownFlag.homeY;
  run(room, 0.1, freeze);
  ok(enemyFlag.state === FLAG_CARRIED && enemyFlag.carrier === a.id, 'ctf: documenti presi');
  // b (avversario) uccide il portatore: i documenti cadono
  (room as unknown as { damagePlayer(v: SPlayer, d: number, by: SPlayer, e: null): void }).damagePlayer(a, 999, b, null);
  ok(enemyFlag.state !== FLAG_CARRIED && enemyFlag.carrier === -1, 'ctf: documenti a terra alla morte del portatore');
  // b (della squadra dei documenti) li tocca: tornano alla base
  b.x = enemyFlag.x; b.y = enemyFlag.y;
  run(room, 0.1, freeze);
  ok(enemyFlag.state === FLAG_HOME, 'ctf: documenti recuperati dalla propria squadra');
  // cattura: a prende i documenti e li porta alla propria base
  run(room, 4, freeze); // a rinasce
  b.x = ownFlag.homeX + 30;
  a.x = enemyFlag.homeX; a.y = enemyFlag.homeY;
  run(room, 0.1, freeze);
  a.x = ownFlag.homeX; a.y = ownFlag.homeY;
  run(room, 0.1, freeze);
  ok(room.teamScore[a.team] === 1 && enemyFlag.state === FLAG_HOME, `ctf: cattura (${room.teamScore})`);
  ok(a.delta.captures === 1 && a.delta.xp >= XP_CAPTURE, 'ctf: cattura registrata con EXP');
  for (let i = 1; i < CTF_LIMIT; i++) {
    a.x = enemyFlag.homeX; a.y = enemyFlag.homeY; run(room, 0.1, freeze);
    a.x = ownFlag.homeX; a.y = ownFlag.homeY; run(room, 0.1, freeze);
  }
  ok(room.pendingLevel > 0 && a.delta.wins === 1, `ctf: vittoria a ${CTF_LIMIT} catture`);
}

console.log(failed ? `FALLITO: ${failed} controlli` : 'OK: tutti i controlli superati');
process.exit(failed ? 1 : 0);
