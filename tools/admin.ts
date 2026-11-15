// Gestione degli amministratori da riga di comando (sul server, accanto al database).
//
//   node tools/admin.ts list                elenca gli amministratori
//   node tools/admin.ts promote <nome>      dà il ruolo admin a un account esistente
//   node tools/admin.ts demote <nome>       toglie il ruolo admin
//   node tools/admin.ts create <nome>       crea un account admin; la password si legge
//                                           dallo standard input (non finisce nella cronologia)
//   node tools/admin.ts unban <nome>        riattiva un account sospeso
//
// Usa DB_PATH come il server (default data/ironward.db). Può girare a server acceso.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameDb } from '../server/db.ts';

const DB_PATH = process.env.DB_PATH ?? resolve(fileURLToPath(new URL('../data/ironward.db', import.meta.url)));
const [cmd, name] = process.argv.slice(2);
const db = new GameDb(DB_PATH);

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Password (almeno 6 caratteri): ');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function fail(msg: string): never {
  console.error(msg);
  db.close();
  process.exit(1);
}

switch (cmd) {
  case 'list': {
    const admins = db.listAdmins();
    console.log(admins.length ? admins.join('\n') : '(nessun amministratore)');
    break;
  }
  case 'promote':
  case 'demote': {
    if (!name) fail(`Uso: node tools/admin.ts ${cmd} <nome>`);
    if (!db.setRole(name, cmd === 'promote' ? 'admin' : '')) fail(`Account "${name}" non trovato`);
    db.logAdmin(null, 'riga di comando', cmd === 'promote' ? 'ruolo admin dato' : 'ruolo admin tolto', name);
    console.log(`${name}: ${cmd === 'promote' ? 'ora è amministratore' : 'non è più amministratore'}`);
    break;
  }
  case 'create': {
    if (!name || !/^[A-Za-z0-9_-]{3,16}$/.test(name)) fail('Uso: node tools/admin.ts create <nome>  (3–16 caratteri tra lettere, cifre, _ e -)');
    const pw = await readPassword();
    if (pw.length < 6 || pw.length > 128) fail('La password deve avere almeno 6 caratteri');
    const u = await db.register(name, pw, 0);
    if (!u) fail(`Il nome "${name}" è già in uso: per dargli il ruolo usa "promote"`);
    db.setRole(name, 'admin');
    db.logAdmin(null, 'riga di comando', 'creazione account admin', name);
    console.log(`Account amministratore "${name}" creato`);
    break;
  }
  case 'unban': {
    const u = name ? db.userByName(name) : null;
    if (!u) fail(`Account "${name ?? ''}" non trovato`);
    db.unban(u.id);
    db.logAdmin(null, 'riga di comando', 'riattivazione', u.profile.name);
    console.log(`${u.profile.name}: account riattivato`);
    break;
  }
  default:
    fail('Comandi: list, promote <nome>, demote <nome>, create <nome>, unban <nome>');
}
db.close();
