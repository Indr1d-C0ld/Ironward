// Test del database: account, sessioni, statistiche, classifiche, curva EXP.
// Uso: node tools/test-db.ts

import { ClanError, GameDb } from '../server/db.ts';
import { emptyDelta, levelFromXp, perksFor, xpForLevel } from '../shared/progression.ts';

let failed = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

// Curva EXP
ok(xpForLevel(1) === 0 && xpForLevel(2) === 100 && xpForLevel(3) === 260, 'curva: 0 / 100 / 260 EXP per i livelli 1–3');
let monotone = true;
for (let l = 1; l < 50; l++) if (levelFromXp(xpForLevel(l)) !== l || levelFromXp(xpForLevel(l + 1) - 1) !== l) monotone = false;
ok(monotone, 'curva: levelFromXp è l’inversa di xpForLevel');
ok(perksFor(15, true).maxHp === 130 && perksFor(15, false).maxHp === 100, 'bonus: solo in cooperativa');

const db = new GameDb(':memory:');
const a = await db.register('Alfa', 'segreto1', 2);
ok(a !== null && a.profile.level === 1 && a.profile.color === 2, 'registrazione');
ok((await db.register('alfa', 'altro123', 0)) === null, 'nome duplicato rifiutato (senza distinzione maiuscole)');
ok((await db.login('Alfa', 'sbagliata')) === null, 'password errata rifiutata');
ok((await db.login('Nessuno', 'segreto1')) === null, 'utente inesistente rifiutato');
const logged = await db.login('ALFA', 'segreto1');
ok(logged?.id === a!.id, 'accesso con maiuscole diverse');

const token = db.createSession(a!.id);
ok(db.userByToken(token)?.id === a!.id, 'sessione valida');
ok(db.userByToken(token + 'x') === null && db.userByToken('corto') === null, 'token non validi rifiutati');

const d = emptyDelta();
Object.assign(d, { xp: 350, kills: 12, deaths: 3, shots: 40, hits: 22, bestStreak: 4, bestScore: 2500, playtime: 300 });
db.applyDelta(a!.id, d, 'coop');
db.applyDelta(a!.id, { ...emptyDelta(), xp: 50, kills: 1, bestStreak: 2, bestScore: 100 }, 'coop');
const p = db.userById(a!.id)!.profile;
ok(p.xp === 400 && p.level === levelFromXp(400), `EXP sommata (${p.xp}, livello ${p.level})`);
ok(p.stats.kills === 13 && p.stats.shots === 40 && p.stats.playtime === 300, 'statistiche sommate');
ok(p.stats.bestStreak === 4 && p.stats.bestScore === 2500, 'record: si tiene il massimo');

const b = await db.register('Bravo', 'segreto2', 0);
db.applyDelta(b!.id, { ...emptyDelta(), xp: 900, frags: 7 }, 'dm');
db.applyDelta(b!.id, { ...emptyDelta(), xp: 100, captures: 2 }, 'ctf');
ok(db.userById(b!.id)!.profile.stats.captures === 2, 'catture salvate');
const lbCap = db.leaderboard('captures', 'week');
ok(lbCap.length === 1 && lbCap[0].value === 2, 'classifica settimanale delle catture');
let threw = false;
try { db.leaderboard('pass' as never, 'all'); } catch { threw = true; }
ok(threw, 'classifica: colonna non ammessa rifiutata');
const lbXp = db.leaderboard('xp', 'all');
ok(lbXp.length === 2 && lbXp[0].name === 'Bravo', 'classifica EXP');
const lbWeek = db.leaderboard('frags', 'week');
ok(lbWeek.length === 1 && lbWeek[0].value === 7, 'classifica settimanale dei frag');

db.setCosmetics(a!.id, 1, 2);
const c = db.userById(a!.id)!.profile;
ok(c.color === 1 && c.hat === 2 && c.tag === '' && c.clan === null, 'personalizzazione salvata');

// Clan
const err = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return e instanceof ClanError ? e.message : `ALTRO: ${e}`; } };
ok(err(() => db.createClan(a!.id, 2, 'AB', 'Lupi di ferro')).includes('livello'), 'clan: serve il livello minimo');
ok(err(() => db.createClan(a!.id, 5, 'A', 'Lupi di ferro')).includes('Sigla'), 'clan: sigla troppo corta rifiutata');
ok(err(() => db.createClan(a!.id, 5, 'LUP', 'Lupi di ferro')) === '', 'clan: fondato');
const pa = db.userById(a!.id)!.profile;
ok(pa.tag === 'LUP' && pa.clan?.owner === true && pa.clan.name === 'Lupi di ferro', 'clan: il fondatore è capo e ha la sigla');
ok(err(() => db.createClan(b!.id, 5, 'LUP', 'Altro')).includes('già in uso'), 'clan: sigla duplicata rifiutata');
ok(err(() => db.createClan(a!.id, 5, 'NEW', 'Nuovo')).includes('già in un clan'), 'clan: un solo clan per giocatore');
const code = db.clanInfo('LUP', a!.id)!.code!;
ok(/^[A-Z2-9]{8}$/.test(code) && db.clanInfo('LUP', b!.id)!.code === undefined, 'clan: codice visibile solo ai membri');
ok(err(() => db.joinClan(b!.id, 'SBAGLIATO')).includes('non valido'), 'clan: codice errato rifiutato');
ok(err(() => db.joinClan(b!.id, code.toLowerCase())) === '', 'clan: ingresso con il codice');
ok(db.userById(b!.id)!.profile.tag === 'LUP' && db.userById(b!.id)!.profile.clan?.owner === false, 'clan: il nuovo membro ha la sigla');
db.applyDelta(b!.id, { ...emptyDelta(), xp: 40, frags: 3, wins: 1 }, 'tdm');
const info = db.clanInfo('LUP')!;
ok(info.members.length === 2 && info.stats.frags === 3 && info.stats.wins === 1 && info.stats.xp === 40, 'clan: contano solo i contributi da membro');
ok(db.clanLeaderboard('frags', 'week')[0]?.tag === 'LUP', 'clan: classifica dei clan');
const newCode = db.newClanCode(a!.id);
ok(newCode !== code && err(() => db.newClanCode(b!.id)).includes('Solo il capo'), 'clan: nuovo codice solo dal capo');
// Sfida tra clan
const d2 = await db.register('Charlie', 'segreto3', 0);
const d3 = await db.register('Delta', 'segreto4', 0);
db.createClan(d2!.id, 4, 'ORS', 'Orsi');
db.joinClan(d3!.id, db.clanInfo('ORS', d2!.id)!.code!);
db.recordClanMatch('ctf', 'LUP', 'ORS', 'ORS');
db.recordClanMatch('tdm', 'ORS', 'LUP', null);
const wl = db.clanInfo('LUP')!.wars, wo = db.clanInfo('ORS')!.wars;
ok(wl.lost === 1 && wl.drawn === 1 && wo.won === 1 && wo.drawn === 1, 'clan: sfide vinte, perse e pareggiate');
ok(db.clanLeaderboard('wars', 'all')[0]?.tag === 'ORS', 'clan: classifica delle sfide vinte');
ok(db.leaderboard('xp', 'all').find((r) => r.name === 'Bravo')?.tag === 'LUP', 'clan: sigla nella classifica giocatori');
// Uscite, allontanamento, passaggio di comando, scioglimento
ok(err(() => db.kickMember(b!.id, 'Alfa')).includes('Solo il capo'), 'clan: solo il capo allontana');
ok(db.kickMember(a!.id, 'bravo') === b!.id && db.userById(b!.id)!.profile.clan === null, 'clan: membro allontanato');
db.joinClan(b!.id, newCode);
db.transferClan(a!.id, 'Bravo');
ok(db.userById(b!.id)!.profile.clan?.owner === true && db.userById(a!.id)!.profile.clan?.owner === false, 'clan: comando ceduto');
db.leaveClan(b!.id);
ok(db.userById(a!.id)!.profile.clan?.owner === true, 'clan: se esce il capo comanda chi resta');
db.leaveClan(a!.id);
ok(db.clanInfo('LUP') === null && db.clanInfo('ORS')!.wars.lost === 0 && db.clanInfo('ORS')!.wars.won === 0, 'clan: l’ultimo che esce lo scioglie (con il suo storico)');

db.deleteSession(token);
ok(db.userByToken(token) === null, 'logout invalida la sessione');
// Amministrazione
const e1 = await db.register('Echo', 'segreto5', 0);
ok(db.setRole('echo', 'admin') && db.userById(e1!.id)!.profile.admin === true && db.listAdmins().includes('Echo'), 'admin: ruolo assegnato');
ok(db.userById(b!.id)!.profile.admin === undefined, 'admin: gli altri non sono amministratori');
const tb = db.createSession(b!.id);
db.ban(b!.id, 'imbrogli');
ok(db.userByToken(tb) === null && db.userById(b!.id)!.banned === 'imbrogli', 'admin: sospensione chiude le sessioni');
ok((await db.login('Bravo', 'segreto2'))?.banned === 'imbrogli', 'admin: il login segnala la sospensione');
ok(err(() => db.ban(e1!.id, 'x')).includes('amministratore'), 'admin: un amministratore non si sospende');
db.unban(b!.id);
ok(db.userById(b!.id)!.banned === null, 'admin: riattivazione');
db.renameUser(b!.id, 'Bravissimo');
ok(db.userByName('bravissimo')?.id === b!.id && err(() => db.renameUser(b!.id, 'Echo')).includes('già in uso'), 'admin: cambio nome (unico)');
db.applyDelta(b!.id, { ...emptyDelta(), xp: 70, frags: 2 }, 'dm');
db.resetStats(b!.id);
const rb = db.userById(b!.id)!.profile;
ok(rb.xp === 0 && rb.stats.frags === 0 && rb.stats.captures === 0 && !db.leaderboard('frags', 'week').some((r) => r.name === 'Bravissimo'), 'admin: statistiche azzerate, anche in classifica');
db.setXp(b!.id, 500);
ok(db.userById(b!.id)!.profile.xp === 500, 'admin: EXP corretta');
const users = db.searchUsers('rav');
ok(users.length === 1 && users[0].name === 'Bravissimo' && db.searchUsers('%').length === 0, 'admin: ricerca giocatori (con % letterale)');
ok(db.renameClan('ORS', 'BRN', 'Orsi Grigi').length === 2 && db.clanInfo('BRN')?.name === 'Orsi Grigi', 'admin: clan rinominato');
ok(db.disbandClan('BRN').length === 2 && db.clanInfo('BRN') === null && db.userById(d2!.id)!.profile.clan === null, 'admin: clan sciolto');
db.logAdmin(e1!.id, 'Echo', 'prova', 'Bravissimo', 'dettaglio');
ok(db.adminLog()[0]?.action === 'prova', 'admin: registro delle azioni');
db.close();

console.log(failed ? `FALLITO: ${failed} controlli` : 'OK: tutti i controlli superati');
process.exit(failed ? 1 : 0);
