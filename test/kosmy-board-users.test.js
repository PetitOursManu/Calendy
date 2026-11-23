'use strict';
/**
 * Utilisateurs gérés par Kosmy Board (protocole kosmy.board-users.v1) : face à un faux Kosmy Board qui signe des jetons
 * d'admin et des ID tokens (avec ou sans la revendication kosmy_board_access), comme le ferait le vrai Board.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creerKosmyBoard, enteteBasic, defiPkce } = require('../kosmy-board.js');
const { refusRestrictions, AccesErreur } = require('../kosmy-board-users.js');

/* ---------------- clés et jetons de test ---------------- */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const autre = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'cle-1', use: 'sig', alg: 'RS256' };

function signer(charge, { kid = 'cle-1', typ = 'kb-admin+jwt', cle = privateKey } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const entete = b64({ alg: 'RS256', kid, ...(typ ? { typ } : {}) });
  const corps = b64(charge);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${entete}.${corps}`), cle).toString('base64url');
  return `${entete}.${corps}.${sig}`;
}

const TOKEN = 'jeton-users-board-0123456789';
const PORT = 4100 + Math.floor(Math.random() * 90);
const APP = `http://127.0.0.1:${PORT}`;
const USERS = '/api/kosmy-board/users';
const ADMIN = '/api/kosmy-board/admin';
const SECRET = 'secret-client-users';
let child;
let dataDir;
let board;
let EMETTEUR;
const codes = new Map();

/** Le jeton que le Board fabrique pour UNE requête : htm, htu, jti, 60 s de validité. `sub` : la personne qui agit. */
function jetonAdmin(method, chemin, { sub = 'sub-alice', ...autres } = {}, options = {}) {
  const t = Math.floor(Date.now() / 1000);
  return signer({
    iss: EMETTEUR, aud: 'client-cal', sub, iat: t, exp: t + 60,
    jti: crypto.randomBytes(16).toString('base64url'),
    htm: method, htu: `${APP}${chemin}`,
    ...autres,
  }, options);
}

async function users(method, chemin, { body, jeton, sub, lang = 'fr' } = {}) {
  const j = jeton === undefined ? jetonAdmin(method, chemin, sub ? { sub } : {}) : jeton;
  const h = { 'Accept-Language': lang, Accept: 'application/json' };
  if (j) h.Authorization = `Bearer ${j}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(APP + chemin, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  const texte = await res.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* pas du JSON */ }
  return { status: res.status, json, texte, res };
}

/* ---------------- faux Board, et Calendy ---------------- */

function demarrerBoard() {
  board = http.createServer(async (req, res) => {
    const url = new URL(req.url, EMETTEUR);
    const json = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/oidc/.well-known/openid-configuration') {
      return json(200, { issuer: EMETTEUR, authorization_endpoint: `${EMETTEUR}/auth`, token_endpoint: `${EMETTEUR}/token`, jwks_uri: `${EMETTEUR}/jwks` });
    }
    if (url.pathname === '/oidc/jwks') return json(200, { keys: [JWK] });
    if (url.pathname === '/oidc/token' && req.method === 'POST') {
      let corps = '';
      for await (const c of req) corps += c;
      const f = new URLSearchParams(corps);
      const c = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (req.headers.authorization !== enteteBasic('client-cal', SECRET)) return json(401, { error: 'invalid_client' });
      if (!c || defiPkce(f.get('code_verifier') || '') !== c.challenge) return json(400, { error: 'invalid_grant' });
      const t = Math.floor(Date.now() / 1000);
      const id_token = signer({
        iss: EMETTEUR, aud: 'client-cal', sub: c.sub, nonce: c.nonce, iat: t, exp: t + 300, name: c.nom, email: c.email,
        ...(c.acces ? { kosmy_board_access: c.acces } : {}),
      }, { typ: 'JWT' });
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token });
    }
    json(404, { error: 'introuvable' });
  });
  return new Promise((resolve) => board.listen(0, '127.0.0.1', () => {
    EMETTEUR = `http://127.0.0.1:${board.address().port}/oidc`;
    resolve();
  }));
}

async function appel(method, chemin, { body, token = TOKEN, cookie } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(APP + chemin, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const texte = await res.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* page HTML */ }
  return { status: res.status, json, texte, res };
}

const cookiesDe = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

/** Parcours complet sur le faux Board, depuis une adresse de départ et son cookie de parcours. */
async function terminerChez(debut, compte) {
  const u = new URL(debut.url);
  const code = crypto.randomBytes(12).toString('hex');
  codes.set(code, { challenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce'), ...compte });
  const q = new URLSearchParams({ code, state: u.searchParams.get('state'), iss: EMETTEUR });
  return appel('GET', `/auth/kosmy-board/callback?${q}`, { token: '', cookie: debut.cookie });
}

/** « Se connecter avec Kosmy Board » : renvoie la réponse du retour et le cookie de session éventuel. */
async function connexion(compte) {
  const login = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  const r = await terminerChez({ url: login.res.headers.get('location'), cookie: cookiesDe(login.res).join('; ') }, compte);
  return { ...r, session: cookiesDe(r.res).find((c) => c.startsWith('calendy_kb_session=')) || '' };
}

const utilisateur = async (sub) => (await users('GET', USERS)).json.users.find((u) => u.sub === sub);

before(async () => {
  await demarrerBoard();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-kb-users-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CALENDY_TOKEN: TOKEN, CALENDY_NO_SEED: '1', CALENDY_PUBLIC_URL: APP, ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', MOCKY_URL: '', MOCKY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
    child.on('exit', (code) => reject(new Error(`serveur arrêté (code ${code})`)));
    setTimeout(() => reject(new Error('démarrage trop long')), 30000).unref();
  });
});

after(() => {
  child.kill();
  board.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ---------------- tests ---------------- */

test('restrictions : ce qu’une session limitée ne peut pas faire', () => {
  assert.equal(refusRestrictions('POST', '/api/posts', { lectureSeule: false, agentIA: true }), null);
  assert.match(refusRestrictions('POST', '/api/posts', { lectureSeule: true, agentIA: true }), /lecture seule/);
  assert.match(refusRestrictions('DELETE', '/api/evenements/x', { lectureSeule: true, agentIA: true }), /lecture seule/);
  assert.equal(refusRestrictions('GET', '/api/export.xlsx', { lectureSeule: true, agentIA: true }), null);
  assert.match(refusRestrictions('POST', '/api/agent/message', { lectureSeule: false, agentIA: false }), /agent IA/);
  assert.match(refusRestrictions('GET', '/api/agent/modeles', { lectureSeule: false, agentIA: false }), /agent IA/);
  assert.equal(refusRestrictions('GET', '/api/agent/reglages', { lectureSeule: false, agentIA: false }), null);
  assert.equal(refusRestrictions('POST', '/api/posts', { lectureSeule: false, agentIA: false }), null);
});

test('jamais zéro administrateur actif, même quand la personne qui agit n’est pas dans la liste', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-kb-users-unit-'));
  try {
    fs.writeFileSync(path.join(dir, 'kosmy-board.json'), JSON.stringify({ comptes: [{ sub: 'a', par: 'jeton' }, { sub: 'b', par: 'admission-auto' }] }));
    const k = creerKosmyBoard({ dataDir: dir, HttpError: Error, jetonDefini: true });
    assert.throws(() => k.appliquerAcces('a', { role: 'member' }, { moi: 'x' }), (e) => e instanceof AccesErreur && e.status === 409 && e.cle === 'err.dernierAdmin');
    assert.throws(() => k.desactiver('a', { moi: 'x' }), (e) => e instanceof AccesErreur && e.status === 409 && e.cle === 'err.dernierAdmin');
    assert.equal(k.desactiver('b', { moi: 'x' }), true);
    assert.equal(k.appliquerAcces('b', { role: 'admin' }, { moi: 'x' }).status, 'updated');
    assert.equal(k.appliquerAcces('a', { role: 'member' }, { moi: 'x' }).compte.role, 'member');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('connexion unique non réglée : 401 invalid_token, en JSON', async () => {
  const r = await users('GET', USERS);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_token');
  assert.ok(r.json.message);
});

test('mise en place : connexion unique réglée, Alice reliée avec le jeton (administratrice)', async () => {
  assert.equal((await appel('PUT', '/api/kosmy-board/reglages', { body: { emetteur: EMETTEUR, clientId: 'client-cal', secret: SECRET } })).status, 200);
  const relier = await appel('POST', '/api/kosmy-board/relier', { body: {} });
  const r = await terminerChez({ url: relier.json.url, cookie: cookiesDe(relier.res).join('; ') }, { sub: 'sub-alice', nom: 'Alice', email: 'alice@exemple.fr' });
  assert.equal(r.status, 303);
});

test('GET : rôles, restrictions et comptes, sans CORS ni cache', async () => {
  const r = await users('GET', USERS);
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.match(r.res.headers.get('content-type'), /^application\/json; charset=utf-8/);
  for (const [nom] of r.res.headers) assert.ok(!nom.startsWith('access-control-'), `en-tête CORS inattendu : ${nom}`);
  assert.equal(r.json.protocol, 'kosmy.board-users.v1');
  assert.deepEqual(r.json.roles.map((x) => [x.value, x.admin === true]), [['admin', true], ['member', false]]);
  assert.equal(r.json.roles[0].label, 'Administrateur');
  assert.equal(r.json.defaultRole, 'member');
  assert.deepEqual(r.json.fields.map((f) => [f.name, f.type, f.value, f.roles]), [['lectureSeule', 'checkbox', false, ['member']], ['agentIA', 'checkbox', true, ['member']]]);
  assert.ok(r.json.fields.every((f) => f.label && f.help));
  assert.deepEqual(r.json.users, [{ sub: 'sub-alice', role: 'admin', values: { lectureSeule: false, agentIA: true }, active: true, account: 'alice@exemple.fr' }]);
  for (const secret of [SECRET, TOKEN]) assert.ok(!r.texte.includes(secret));
  // En anglais avec Accept-Language: en ; une barre finale est la même adresse.
  const en = await users('GET', `${USERS}/`, { jeton: jetonAdmin('GET', USERS), lang: 'en-GB,en;q=0.9' });
  assert.equal(en.status, 200);
  assert.equal(en.json.roles[0].label, 'Administrator');
  assert.equal(en.json.fields[0].label, 'Read only');
});

test('jeton refusé : ID token, autre clé, mauvais htm ou htu, jti déjà vu, CALENDY_TOKEN', async () => {
  const t = Math.floor(Date.now() / 1000);
  const idToken = signer({ iss: EMETTEUR, aud: 'client-cal', sub: 'sub-alice', nonce: 'n', iat: t, exp: t + 300, jti: 'x-1', htm: 'GET', htu: `${APP}${USERS}` }, { typ: 'JWT' });
  const corps = { role: 'member', name: 'Pirate', email: 'pirate@exemple.fr' };
  for (const [method, chemin, jeton, body] of [
    ['GET', USERS, idToken],
    ['GET', USERS, jetonAdmin('GET', USERS, {}, { cle: autre.privateKey })],
    ['GET', USERS, jetonAdmin('GET', USERS, { aud: 'autre-client' })],
    ['GET', USERS, TOKEN],
    ['GET', USERS, ''],
    // Fait pour un GET, envoyé en PUT ; fait pour un autre compte ; fait pour la liste ; fait pour l'admin.
    ['PUT', `${USERS}/sub-pirate`, jetonAdmin('GET', `${USERS}/sub-pirate`), corps],
    ['PUT', `${USERS}/sub-pirate`, jetonAdmin('PUT', `${USERS}/sub-autre`), corps],
    ['PUT', `${USERS}/sub-pirate`, jetonAdmin('PUT', USERS), corps],
    ['DELETE', `${USERS}/sub-alice`, jetonAdmin('DELETE', `${ADMIN}`)],
    ['GET', USERS, jetonAdmin('GET', ADMIN)],
  ]) {
    const r = await users(method, chemin, { jeton, body });
    assert.equal(r.status, 401, `${method} ${chemin}`);
    assert.equal(r.json.error, 'invalid_token');
  }
  const jeton = jetonAdmin('GET', USERS);
  assert.equal((await users('GET', USERS, { jeton })).status, 200);
  assert.equal((await users('GET', USERS, { jeton })).status, 401);
  assert.equal(await utilisateur('sub-pirate'), undefined);
  // Le chemin de htu peut avoir un préfixe (Calendy derrière un proxy) : il doit seulement se terminer pareil.
  assert.equal((await users('GET', USERS, { jeton: jetonAdmin('GET', USERS, { htu: `https://exemple.fr/calendy${USERS}` }) })).status, 200);
});

test('not_linked : la personne qui agit n’a pas de compte dans Calendy', async () => {
  const r = await users('PUT', `${USERS}/sub-zoe`, { sub: 'sub-inconnu', body: { role: 'member' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'not_linked');
  assert.ok(r.json.message);
});

test('PUT : crée un compte (sans mot de passe, relié au sub), idempotent', async () => {
  const corps = { name: 'Bob Martin', email: 'bob@exemple.fr', locale: 'fr', role: 'member', values: { lectureSeule: true } };
  const r = await users('PUT', `${USERS}/sub-bob`, { body: corps });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, status: 'created', account: 'bob@exemple.fr', message: 'Compte créé dans Calendy.' });
  assert.deepEqual(await utilisateur('sub-bob'), { sub: 'sub-bob', role: 'member', values: { lectureSeule: true, agentIA: true }, active: true, account: 'bob@exemple.fr' });
  const compte = (await appel('GET', '/api/kosmy-board/reglages')).json.comptes.find((c) => c.sub === 'sub-bob');
  assert.equal(compte.par, 'board');
  assert.equal(compte.nom, 'Bob Martin');
  // Le même PUT deux fois : même état.
  const encore = await users('PUT', `${USERS}/sub-bob`, { body: corps, lang: 'en' });
  assert.equal(encore.json.status, 'updated');
  assert.equal(encore.json.message, 'Account updated in Calendy.');
  assert.deepEqual(await utilisateur('sub-bob'), { sub: 'sub-bob', role: 'member', values: { lectureSeule: true, agentIA: true }, active: true, account: 'bob@exemple.fr' });
  // Un champ absent garde sa valeur ; un rôle sans champs (admin) ne touche pas aux restrictions.
  await users('PUT', `${USERS}/sub-bob`, { body: { role: 'member', values: { agentIA: false } } });
  assert.deepEqual((await utilisateur('sub-bob')).values, { lectureSeule: true, agentIA: false });
  await users('PUT', `${USERS}/sub-bob`, { body: { role: 'member', values: { lectureSeule: true, agentIA: true } } });
});

test('PUT : compte déjà relié (Alice, reliée avec le jeton) → updated, nom et e-mail mis à jour', async () => {
  const r = await users('PUT', `${USERS}/sub-alice`, { body: { name: 'Alice Durand', email: 'alice.durand@exemple.fr', role: 'admin' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'updated');
  const compte = (await appel('GET', '/api/kosmy-board/reglages')).json.comptes.find((c) => c.sub === 'sub-alice');
  assert.equal(compte.nom, 'Alice Durand');
  assert.equal(compte.email, 'alice.durand@exemple.fr');
  assert.equal(compte.par, 'jeton');
  assert.equal(compte.role, 'admin');
});

test('PUT : adresse e-mail d’un autre compte admis → 409 ; valeurs refusées → 422', async () => {
  const conflit = await users('PUT', `${USERS}/sub-carole`, { body: { name: 'Carole', email: 'BOB@exemple.fr', role: 'member' } });
  assert.equal(conflit.status, 409);
  assert.equal(conflit.json.error, 'conflict');
  assert.match(conflit.json.message, /Bob Martin/);
  assert.equal(await utilisateur('sub-carole'), undefined);

  for (const body of [
    { role: 'chef' },
    {},
    { role: 'member', values: { lectureSeule: 'oui' } },
    { role: 'member', values: [true] },
  ]) {
    const r = await users('PUT', `${USERS}/sub-carole`, { body });
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(r.json.error, 'invalid');
    assert.ok(r.json.message);
  }
  const en = await users('PUT', `${USERS}/sub-carole`, { body: { role: 'member', values: { agentIA: 1 } }, lang: 'en' });
  assert.equal(en.json.message, '“Can use the AI agent”: yes or no.');
  assert.equal((await users('PUT', `${USERS}/sub-carole`, { body: 'pas du json' })).status, 400);
  assert.equal(await utilisateur('sub-carole'), undefined);
  // Identifiant de compte invalide, méthode non prévue.
  assert.equal((await users('PUT', `${USERS}/sub_carole!`, { body: { role: 'member' } })).status, 404);
  assert.equal((await users('POST', USERS, { body: {} })).json.error, 'method_not_allowed');
  assert.equal((await users('GET', `${USERS}/sub-bob`)).status, 405);
});

test('restrictions appliquées à la session : lecture seule, puis sans agent IA', async () => {
  const bob = await connexion({ sub: 'sub-bob', nom: 'Bob Martin', email: 'bob@exemple.fr' });
  assert.equal(bob.status, 303);
  assert.ok(bob.session);
  const s = (await appel('GET', '/api/session', { token: '', cookie: bob.session })).json;
  assert.equal(s.acces, 'kosmy');
  assert.equal(s.compte.role, 'member');
  assert.deepEqual(s.compte.restrictions, { lectureSeule: true, agentIA: true });
  assert.equal((await appel('GET', '/api/state', { token: '', cookie: bob.session })).status, 200);
  assert.equal((await appel('GET', '/api/export.xlsx', { token: '', cookie: bob.session })).status, 200);
  const refus = await appel('POST', '/api/posts', { token: '', cookie: bob.session, body: { titre: 'Bob', datePublication: '2030-02-01', plateformes: ['Instagram'] } });
  assert.equal(refus.status, 403);
  assert.match(refus.json.error, /lecture seule/);
  assert.equal((await appel('PUT', '/api/reglages', { token: '', cookie: bob.session, body: { structure: 'Bob' } })).status, 403);
  // Se déconnecter reste possible.
  assert.equal((await appel('POST', '/api/kosmy-board/deconnexion', { token: '', cookie: bob.session, body: {} })).status, 200);

  await users('PUT', `${USERS}/sub-bob`, { body: { role: 'member', values: { lectureSeule: false, agentIA: false } } });
  const cree = await appel('POST', '/api/posts', { token: '', cookie: bob.session, body: { titre: 'Bob', datePublication: '2030-02-01', plateformes: ['Instagram'] } });
  assert.equal(cree.status, 201);
  const agent = await appel('POST', '/api/agent/message', { token: '', cookie: bob.session, body: { messages: [{ role: 'user', content: 'Bonjour' }] } });
  assert.equal(agent.status, 403);
  assert.match(agent.json.error, /agent IA/);
  assert.equal((await appel('PUT', '/api/agent/reglages', { token: '', cookie: bob.session, body: { nom: 'Bob' } })).status, 403);
  assert.equal((await appel('GET', '/api/agent/reglages', { token: '', cookie: bob.session })).status, 200);
  // Le jeton d'accès de Calendy, lui, n'a pas de restriction.
  assert.notEqual((await appel('PUT', '/api/agent/reglages', { body: { nom: 'Plume' } })).status, 403);
  // Un membre n'administre pas les comptes depuis le Board.
  const membre = await users('GET', USERS, { sub: 'sub-bob' });
  assert.equal(membre.status, 403);
  assert.equal(membre.json.error, 'forbidden');
});

test('DELETE : désactive le compte, ferme sa session, et la connexion par le Board est refusée', async () => {
  const bob = await connexion({ sub: 'sub-bob', nom: 'Bob Martin', email: 'bob@exemple.fr' });
  assert.equal((await appel('GET', '/api/state', { token: '', cookie: bob.session })).status, 200);

  const r = await users('DELETE', `${USERS}/sub-bob`);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal((await utilisateur('sub-bob')).active, false);
  // Ses données restent (ses restrictions aussi) ; sa session ne marche plus.
  assert.deepEqual((await utilisateur('sub-bob')).values, { lectureSeule: false, agentIA: false });
  assert.equal((await appel('GET', '/api/state', { token: '', cookie: bob.session })).status, 401);
  const encore = await connexion({ sub: 'sub-bob', nom: 'Bob Martin', email: 'bob@exemple.fr' });
  assert.equal(encore.status, 403);
  assert.equal(encore.session, '');
  assert.match(encore.texte, /désactivé/);
  // L'admin dans le Board est refusée aussi.
  assert.equal((await users('PUT', `${USERS}/sub-bob`, { body: { role: 'admin' } })).status, 200);
  await users('DELETE', `${USERS}/sub-bob`, { jeton: jetonAdmin('DELETE', `${USERS}/sub-bob`, { sub: 'sub-alice' }) });
  const adminBob = await users('GET', ADMIN, { jeton: jetonAdmin('GET', ADMIN, { sub: 'sub-bob' }) });
  assert.equal(adminBob.status, 403);
  assert.equal(adminBob.json.error, 'forbidden');
  // La section Kosmy Board de l'admin le montre désactivé.
  const kb = await users('GET', `${ADMIN}/kosmy-board`, { jeton: jetonAdmin('GET', `${ADMIN}/kosmy-board`) });
  assert.equal(kb.json.blocks.find((b) => b.id === 'comptes').rows.find((x) => x.id === 'sub-bob').cells.role.text, 'Désactivé');

  // Déjà désactivé, ou aucun compte : rien à faire, 200 quand même.
  assert.equal((await users('DELETE', `${USERS}/sub-bob`)).status, 200);
  assert.deepEqual((await users('DELETE', `${USERS}/sub-personne`)).json.ok, true);

  // Un PUT le réactive.
  const retour = await users('PUT', `${USERS}/sub-bob`, { body: { role: 'member', values: { lectureSeule: false, agentIA: true } } });
  assert.equal(retour.json.status, 'updated');
  assert.equal((await utilisateur('sub-bob')).active, true);
  assert.equal((await connexion({ sub: 'sub-bob', nom: 'Bob Martin', email: 'bob@exemple.fr' })).status, 303);
});

test('ne pas se couper l’accès : ses propres droits, son propre compte', async () => {
  const soi = await users('PUT', `${USERS}/sub-alice`, { body: { role: 'member' } });
  assert.equal(soi.status, 409);
  assert.equal(soi.json.error, 'conflict');
  assert.ok(soi.json.message);
  const supprimer = await users('DELETE', `${USERS}/sub-alice`, { lang: 'en' });
  assert.equal(supprimer.status, 409);
  assert.equal(supprimer.json.message, 'You cannot remove your own access.');
  assert.equal((await utilisateur('sub-alice')).role, 'admin');
  assert.equal((await utilisateur('sub-alice')).active, true);

  // Un autre administrateur (nommé depuis le Board) administre Calendy, et peut retirer les droits d'Alice.
  assert.equal((await users('PUT', `${USERS}/sub-dan`, { body: { name: 'Dan', email: 'dan@exemple.fr', role: 'admin' } })).json.status, 'created');
  assert.equal((await users('GET', ADMIN, { jeton: jetonAdmin('GET', ADMIN, { sub: 'sub-dan' }) })).status, 200);
  assert.equal((await users('PUT', `${USERS}/sub-alice`, { sub: 'sub-dan', body: { role: 'member' } })).status, 200);
  assert.equal((await users('GET', USERS)).json.error, 'forbidden');
  assert.equal((await users('PUT', `${USERS}/sub-alice`, { sub: 'sub-dan', body: { role: 'admin' } })).status, 200);
});

test('à la connexion : kosmy_board_access crée le compte, applique le rôle et les restrictions', async () => {
  // Sans la revendication, un compte inconnu reste refusé (admission automatique désactivée).
  const sans = await connexion({ sub: 'sub-erin', nom: 'Erin', email: 'erin@exemple.fr' });
  assert.equal(sans.status, 403);
  assert.equal(await utilisateur('sub-erin'), undefined);

  // Avec : le compte est créé, sans liaison par l'e-mail (même adresse que Bob : deux comptes distincts).
  const avec = await connexion({ sub: 'sub-erin', nom: 'Erin', email: 'bob@exemple.fr', acces: { role: 'member', values: { lectureSeule: true, agentIA: false } } });
  assert.equal(avec.status, 303);
  assert.deepEqual(await utilisateur('sub-erin'), { sub: 'sub-erin', role: 'member', values: { lectureSeule: true, agentIA: false }, active: true, account: 'bob@exemple.fr' });
  assert.equal((await utilisateur('sub-bob')).active, true);
  assert.equal((await appel('POST', '/api/posts', { token: '', cookie: avec.session, body: { titre: 'Erin', datePublication: '2030-03-01' } })).status, 403);

  // La revendication change les restrictions à chaque connexion.
  const apres = await connexion({ sub: 'sub-erin', nom: 'Erin', email: 'erin@exemple.fr', acces: { role: 'member', values: { lectureSeule: false } } });
  assert.equal(apres.status, 303);
  assert.deepEqual((await utilisateur('sub-erin')).values, { lectureSeule: false, agentIA: false });
  assert.equal((await appel('GET', '/api/session', { token: '', cookie: apres.session })).json.compte.nom, 'Erin');

  // Désactivé depuis le Board : sans la revendication, il n'entre plus ; avec, le Board lui a redonné l'accès.
  await users('DELETE', `${USERS}/sub-erin`);
  assert.equal((await connexion({ sub: 'sub-erin', nom: 'Erin', email: 'erin@exemple.fr' })).status, 403);
  assert.equal((await connexion({ sub: 'sub-erin', nom: 'Erin', email: 'erin@exemple.fr', acces: { role: 'member', values: {} } })).status, 303);
  assert.equal((await utilisateur('sub-erin')).active, true);

  // Une revendication illisible : la connexion est refusée avec la raison.
  const illisible = await connexion({ sub: 'sub-frank', nom: 'Frank', email: 'frank@exemple.fr', acces: { role: 'roi' } });
  assert.equal(illisible.status, 403);
  assert.match(illisible.texte, /Rôle inconnu/);
  assert.equal(await utilisateur('sub-frank'), undefined);

  // Le dernier administrateur actif garde son rôle si la revendication le retirerait.
  assert.equal((await users('PUT', `${USERS}/sub-dan`, { body: { role: 'member' } })).status, 200);
  const alice = await connexion({ sub: 'sub-alice', nom: 'Alice', email: 'alice@exemple.fr', acces: { role: 'member', values: {} } });
  assert.equal(alice.status, 303);
  assert.equal((await utilisateur('sub-alice')).role, 'admin');
  // Promu administrateur par la revendication : il administre Calendy depuis le Board.
  assert.equal((await connexion({ sub: 'sub-erin', nom: 'Erin', email: 'erin@exemple.fr', acces: { role: 'admin', values: {} } })).status, 303);
  assert.equal((await users('GET', USERS, { sub: 'sub-erin' })).status, 200);
});
