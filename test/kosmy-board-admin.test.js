'use strict';
/**
 * Admin dans Kosmy Board (protocole kosmy.board-admin.v1) : face à un faux Kosmy Board qui signe des jetons
 * d'admin avec sa clé de test, comme le ferait le serveur du vrai Board.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enteteBasic, defiPkce } = require('../kosmy-board.js');
const { langueDe } = require('../kosmy-board-admin.js');

/* ---------------- clés et jetons de test ---------------- */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const autre = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'cle-1', use: 'sig', alg: 'RS256' };

function signer(charge, { kid = 'cle-1', alg = 'RS256', typ = 'kb-admin+jwt', cle = privateKey } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const entete = b64({ alg, kid, ...(typ ? { typ } : {}) });
  const corps = b64(charge);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${entete}.${corps}`), cle).toString('base64url');
  return `${entete}.${corps}.${sig}`;
}

const TOKEN = 'jeton-admin-board-0123456789';
const PORT = 4000 + Math.floor(Math.random() * 90);
const APP = `http://127.0.0.1:${PORT}`;
const ADMIN = '/api/kosmy-board/admin';
const SECRET = 'secret-client-admin';
let child;
let dataDir;
let board;
let EMETTEUR;
const codes = new Map();

/** Le jeton que le Board fabrique pour UNE requête : htm, htu, jti, 60 s de validité. */
function jetonAdmin(method, chemin, { sub = 'sub-alice', ...autres } = {}, options = {}) {
  const t = Math.floor(Date.now() / 1000);
  return signer({
    iss: EMETTEUR, aud: 'client-cal', sub, iat: t, exp: t + 60,
    jti: crypto.randomBytes(16).toString('base64url'),
    htm: method, htu: `${APP}${chemin}`, name: 'Alice (Board)', email: 'alice@exemple.fr',
    ...autres,
  }, options);
}

async function admin(method, chemin, { body, jeton, sub, lang = 'fr', headers = {} } = {}) {
  const j = jeton === undefined ? jetonAdmin(method, chemin, sub ? { sub } : {}) : jeton;
  const h = { 'Accept-Language': lang, Accept: 'application/json', ...headers };
  if (j) h.Authorization = `Bearer ${j}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(APP + chemin, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
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
      const id_token = signer({ iss: EMETTEUR, aud: 'client-cal', sub: c.sub, nonce: c.nonce, iat: t, exp: t + 300, name: c.nom, email: c.email }, { typ: 'JWT' });
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
  return { status: res.status, json, res };
}

const cookiesDe = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

/** Parcours complet sur le faux Board : le compte `sub` rejoint la liste d'accès de Calendy. */
async function connecter(debut, { sub, nom, email }) {
  const u = new URL(debut.url);
  const code = crypto.randomBytes(12).toString('hex');
  codes.set(code, { challenge: u.searchParams.get('code_challenge'), nonce: u.searchParams.get('nonce'), sub, nom, email });
  const q = new URLSearchParams({ code, state: u.searchParams.get('state'), iss: EMETTEUR });
  return appel('GET', `/auth/kosmy-board/callback?${q}`, { token: '', cookie: debut.cookie });
}

before(async () => {
  await demarrerBoard();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-kb-admin-'));
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

test('langue : Accept-Language, fr par défaut', () => {
  assert.equal(langueDe('en-GB,en;q=0.9'), 'en');
  assert.equal(langueDe('de-DE,en;q=0.8,fr;q=0.9'), 'fr');
  assert.equal(langueDe('fr'), 'fr');
  assert.equal(langueDe(''), 'fr');
  assert.equal(langueDe('de'), 'fr');
});

test('connexion unique non réglée : 401 invalid_token, en JSON', async () => {
  const r = await admin('GET', ADMIN);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_token');
  assert.match(r.res.headers.get('content-type'), /^application\/json; charset=utf-8/);
});

test('mise en place : connexion unique réglée, Alice reliée avec le jeton, Bob admis automatiquement', async () => {
  const r = await appel('PUT', '/api/kosmy-board/reglages', { body: { emetteur: EMETTEUR, clientId: 'client-cal', secret: SECRET, admissionAuto: true } });
  assert.equal(r.status, 200);
  const relier = await appel('POST', '/api/kosmy-board/relier', { body: {} });
  assert.equal((await connecter({ url: relier.json.url, cookie: cookiesDe(relier.res).join('; ') }, { sub: 'sub-alice', nom: 'Alice', email: 'alice@exemple.fr' })).status, 303);
  const login = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  assert.equal((await connecter({ url: login.res.headers.get('location'), cookie: cookiesDe(login.res).join('; ') }, { sub: 'sub-bob', nom: 'Bob', email: 'bob@exemple.fr' })).status, 303);
  await appel('PUT', '/api/kosmy-board/reglages', { body: { admissionAuto: false } });
  const comptes = (await appel('GET', '/api/kosmy-board/reglages')).json.comptes;
  assert.deepEqual(comptes.map((c) => [c.sub, c.par]), [['sub-alice', 'jeton'], ['sub-bob', 'admission-auto']]);
});

test('jeton valide : le sommaire, sans CORS ni cache', async () => {
  const r = await admin('GET', ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.json.protocol, 'kosmy.board-admin.v1');
  assert.equal(r.json.app.name, 'Calendy');
  assert.ok(r.json.app.version);
  assert.deepEqual(r.json.user, { name: 'Alice', role: 'Administrateur' });
  assert.deepEqual(r.json.sections.map((s) => s.id), ['overview', 'general', 'agent', 'mocky', 'kosmy-board']);
  assert.equal(r.json.sections[0].title, 'Vue d’ensemble');
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.match(r.res.headers.get('content-type'), /^application\/json; charset=utf-8/);
  for (const [nom] of r.res.headers) assert.ok(!nom.startsWith('access-control-'), `en-tête CORS inattendu : ${nom}`);
  // Une barre finale est la même adresse.
  assert.equal((await admin('GET', `${ADMIN}/`, { jeton: jetonAdmin('GET', ADMIN) })).status, 200);
});

test('textes en anglais avec Accept-Language: en', async () => {
  const r = await admin('GET', ADMIN, { lang: 'en-US,en;q=0.9' });
  assert.equal(r.json.user.role, 'Administrator');
  assert.equal(r.json.sections[0].title, 'Overview');
  const s = await admin('GET', `${ADMIN}/overview`, { lang: 'en' });
  assert.equal(s.json.title, 'Overview');
  assert.equal(s.json.blocks.find((b) => b.type === 'stats').title, 'Calendar');
});

test('un ID token du Board (ou un JWT sans typ) est refusé', async () => {
  const t = Math.floor(Date.now() / 1000);
  const idToken = signer({ iss: EMETTEUR, aud: 'client-cal', sub: 'sub-alice', nonce: 'n', iat: t, exp: t + 300, jti: 'x-1', htm: 'GET', htu: `${APP}${ADMIN}` }, { typ: 'JWT' });
  const r = await admin('GET', ADMIN, { jeton: idToken });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_token');
  assert.equal((await admin('GET', ADMIN, { jeton: jetonAdmin('GET', ADMIN, {}, { typ: null }) })).status, 401);
});

test('mauvais aud, iss, signature, algorithme ou jeton expiré : 401', async () => {
  for (const jeton of [
    jetonAdmin('GET', ADMIN, { aud: 'autre-client' }),
    jetonAdmin('GET', ADMIN, { iss: 'https://autre.test/oidc' }),
    jetonAdmin('GET', ADMIN, {}, { cle: autre.privateKey }),
    jetonAdmin('GET', ADMIN, {}, { alg: 'HS256' }),
    jetonAdmin('GET', ADMIN, { iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 540 }),
    jetonAdmin('GET', ADMIN, { jti: undefined }),
    'pas-un-jwt',
  ]) {
    const r = await admin('GET', ADMIN, { jeton });
    assert.equal(r.status, 401, jeton);
    assert.equal(r.json.error, 'invalid_token');
  }
  // Sans jeton du tout.
  assert.equal((await admin('GET', ADMIN, { jeton: '' })).status, 401);
  // Le jeton CALENDY_TOKEN n'est pas un jeton du Board.
  assert.equal((await admin('GET', ADMIN, { jeton: TOKEN })).status, 401);
});

test('un jeton ne sert qu’une fois (jti)', async () => {
  const jeton = jetonAdmin('GET', ADMIN);
  assert.equal((await admin('GET', ADMIN, { jeton })).status, 200);
  const r = await admin('GET', ADMIN, { jeton });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_token');
});

test('htm et htu : un jeton ne sert qu’à la requête pour laquelle il a été fait', async () => {
  // Fait pour un GET, envoyé en POST.
  assert.equal((await admin('POST', `${ADMIN}/general`, { jeton: jetonAdmin('GET', `${ADMIN}/general`), body: { action: 'save-general', values: { structure: 'Pirate' } } })).status, 401);
  // Fait pour une autre section, ou pour le sommaire.
  assert.equal((await admin('GET', `${ADMIN}/general`, { jeton: jetonAdmin('GET', `${ADMIN}/agent`) })).status, 401);
  assert.equal((await admin('GET', `${ADMIN}/general`, { jeton: jetonAdmin('GET', ADMIN) })).status, 401);
  assert.equal((await admin('GET', ADMIN, { jeton: jetonAdmin('GET', ADMIN, { htu: 'pas une adresse' }) })).status, 401);
  // Le chemin de htu peut avoir un préfixe (Calendy derrière un proxy sous /calendy) : il doit seulement se terminer pareil.
  assert.equal((await admin('GET', ADMIN, { jeton: jetonAdmin('GET', ADMIN, { htu: `https://exemple.fr/calendy${ADMIN}` }) })).status, 200);
  assert.notEqual((await appel('GET', '/api/reglages')).json.structure, 'Pirate');
});

test('not_linked : compte du Board relié à aucun accès Calendy', async () => {
  const r = await admin('GET', ADMIN, { sub: 'sub-inconnu' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'not_linked');
  assert.match(r.json.message, /Relier à Kosmy Board/);
});

test('forbidden : compte admis automatiquement, sans droits d’administration', async () => {
  const r = await admin('GET', ADMIN, { sub: 'sub-bob' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
  assert.ok(r.json.message);
  assert.equal((await admin('POST', `${ADMIN}/general`, { sub: 'sub-bob', body: { action: 'save-general', values: { structure: 'Bob' } } })).json.error, 'forbidden');
});

test('sections : vue d’ensemble, et aucun secret renvoyé', async () => {
  await appel('POST', '/api/posts', { body: { titre: 'Portes ouvertes', datePublication: '2030-01-15', plateformes: ['Instagram'] } });
  await appel('PUT', '/api/agent/reglages', { body: { cles: { anthropic: 'sk-ant-secret-agent' } } });
  await appel('PUT', '/api/mocky/reglages', { body: { url: 'https://mocky.test', cle: 'mocky_ak_secret' } });

  const ov = await admin('GET', `${ADMIN}/overview`);
  assert.equal(ov.status, 200);
  assert.equal(ov.json.id, 'overview');
  const stats = ov.json.blocks.find((b) => b.type === 'stats');
  assert.equal(stats.items.find((i) => i.label === 'Posts').value, 1);
  assert.equal(stats.items.find((i) => i.label === 'Idées à valider').value, 1);
  assert.equal(stats.items.find((i) => i.label === 'Comptes Kosmy Board').value, 2);
  assert.ok(ov.json.blocks.length <= 30);

  const kb = await admin('GET', `${ADMIN}/kosmy-board`);
  const comptes = kb.json.blocks.find((b) => b.type === 'table' && b.id === 'comptes');
  assert.deepEqual(comptes.rows.map((r) => [r.id, r.cells.role.text, r.actions]), [['sub-alice', 'Administrateur', []], ['sub-bob', 'Calendrier seulement', ['remove-account']]]);
  assert.equal(comptes.rows[0].cells.nom, 'Alice (toi)');

  for (const id of ['overview', 'general', 'agent', 'mocky', 'kosmy-board']) {
    const s = await admin('GET', `${ADMIN}/${id}`);
    assert.equal(s.status, 200, id);
    for (const secret of [SECRET, TOKEN, 'sk-ant-secret-agent', 'mocky_ak_secret']) assert.ok(!s.texte.includes(secret), `${id} révèle un secret`);
    const champs = s.json.blocks.filter((b) => b.type === 'form').flatMap((b) => b.fields);
    for (const f of champs.filter((c) => c.type === 'password')) assert.equal(f.value, undefined, `${id}.${f.name}`);
  }
});

test('section ou action inconnue : 404 not_found', async () => {
  const r = await admin('GET', `${ADMIN}/inconnue`);
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'not_found');
  assert.equal((await admin('POST', `${ADMIN}/general`, { body: { action: 'detruire' } })).json.error, 'not_found');
  assert.equal((await admin('POST', `${ADMIN}/general`, { body: 'pas un objet' })).status, 400);
});

test('action : enregistrer le nom de la structure, par la même fonction que Réglages → Général', async () => {
  const r = await admin('POST', `${ADMIN}/general`, { body: { action: 'save-general', values: { structure: '  ESAT   Elisa 30 ' } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.message, 'Réglages enregistrés.');
  // Même règle que l'interface : espaces réduits.
  assert.equal(r.json.section.blocks[0].fields[0].value, 'ESAT Elisa 30');
  assert.equal((await appel('GET', '/api/reglages')).json.structure, 'ESAT Elisa 30');
  assert.equal((await admin('GET', ADMIN)).json.app.name, 'Calendy · ESAT Elisa 30');
  // Saisie refusée par les règles de Calendy : son message.
  const trop = await admin('POST', `${ADMIN}/general`, { body: { action: 'save-general', values: { structure: 'x'.repeat(81) } } });
  assert.equal(trop.status, 400);
  assert.match(trop.json.message, /80 caractères/);
});

test('action : agent IA (clé en écriture seule) et règle Mocky retirée', async () => {
  const r = await admin('POST', `${ADMIN}/agent`, { body: { action: 'save-agent', values: { actif: true, nom: 'Plume', fournisseur: 'anthropic', modeleAnthropic: 'claude-sonnet-5-5', modeleOpenrouter: '', effort: 'high', instructions: 'Tutoie.', 'perm-supprimer': false, cleAnthropic: '', cleOpenrouter: 'sk-or-nouvelle' } } });
  assert.equal(r.status, 200);
  const a = (await appel('GET', '/api/agent/reglages')).json;
  assert.equal(a.nom, 'Plume');
  assert.equal(a.modeles.anthropic, 'claude-sonnet-5-5');
  assert.equal(a.permissions.supprimer, false);
  assert.equal(a.permissions.cloner, true);
  assert.equal(a.cles.anthropic.definie, true); // vide : gardée
  assert.equal(a.cles.openrouter.definie, true);
  assert.equal((await admin('POST', `${ADMIN}/agent`, { body: { action: 'save-agent', values: { nom: '' } } })).status, 400);
  const retrait = await admin('POST', `${ADMIN}/agent`, { body: { action: 'remove-key-openrouter' } });
  assert.equal(retrait.status, 200);
  assert.equal((await appel('GET', '/api/agent/reglages')).json.cles.openrouter.definie, false);

  await appel('PUT', '/api/mocky/reglages', { body: { themes: [{ theme: 'Cuisine', modele: 'tpl_1' }, { theme: 'Jardin', modele: 'tpl_2' }] } });
  const mk = await admin('GET', `${ADMIN}/mocky`);
  const themes = mk.json.blocks.find((b) => b.id === 'themes');
  const cuisine = themes.rows.find((x) => x.cells.theme === 'Cuisine');
  const apres = await admin('POST', `${ADMIN}/mocky`, { body: { action: 'remove-rule', row: cuisine.id } });
  assert.equal(apres.status, 200);
  assert.deepEqual((await appel('GET', '/api/mocky/reglages')).json.themes.map((x) => x.theme), ['Jardin']);
  assert.deepEqual(apres.json.section.blocks.find((b) => b.id === 'themes').rows.map((x) => x.cells.theme), ['Jardin']);
});

test('Kosmy Board : retirer un compte demande le jeton de Calendy, jamais son propre compte', async () => {
  const faux = await admin('POST', `${ADMIN}/kosmy-board`, { body: { action: 'remove-account', row: 'sub-bob', values: { jeton: 'mauvais' } } });
  assert.equal(faux.status, 422);
  assert.ok(faux.json.message);
  const soi = await admin('POST', `${ADMIN}/kosmy-board`, { body: { action: 'remove-account', row: 'sub-alice', values: { jeton: TOKEN } } });
  assert.equal(soi.status, 422);
  assert.equal((await admin('POST', `${ADMIN}/kosmy-board`, { body: { action: 'remove-account', row: 'sub-inconnu', values: { jeton: TOKEN } } })).status, 404);
  const ok = await admin('POST', `${ADMIN}/kosmy-board`, { body: { action: 'remove-account', row: 'sub-bob', values: { jeton: TOKEN } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.message, 'Compte retiré de la liste.');
  assert.deepEqual((await appel('GET', '/api/kosmy-board/reglages')).json.comptes.map((c) => c.sub), ['sub-alice']);
  // Bob n'est plus relié du tout.
  assert.equal((await admin('GET', ADMIN, { sub: 'sub-bob' })).json.error, 'not_linked');

  // Réglages de la connexion unique : jeton exigé ; un secret vide garde l'actuel.
  assert.equal((await admin('POST', `${ADMIN}/kosmy-board`, { body: { action: 'save-sso', values: { emetteur: EMETTEUR, clientId: 'client-cal', secret: '', admissionAuto: true, jeton: '' } } })).status, 422);
  const sso = await admin('POST', `${ADMIN}/kosmy-board`, { body: { action: 'save-sso', values: { emetteur: EMETTEUR, clientId: 'client-cal', secret: '', admissionAuto: true, jeton: TOKEN } } });
  assert.equal(sso.status, 200);
  const reglages = (await appel('GET', '/api/kosmy-board/reglages')).json;
  assert.equal(reglages.admissionAuto, true);
  assert.equal(reglages.secretDefini, true);
});

test('pas pris par le contrôle d’Origin, le jeton CALENDY_TOKEN ou les pages HTML', async () => {
  // Un en-tête Origin étranger (le serveur du Board n'en envoie pas, mais il ne doit rien changer).
  assert.equal((await admin('GET', ADMIN, { headers: { Origin: 'https://ailleurs.test' } })).status, 200);
  const sans = await admin('GET', `${ADMIN}/overview`, { jeton: '' });
  assert.equal(sans.status, 401);
  assert.equal(sans.json.error, 'invalid_token');
  // Méthode non prévue : JSON, pas de redirection.
  const put = await admin('PUT', `${ADMIN}/general`, { jeton: jetonAdmin('PUT', `${ADMIN}/general`), body: {} });
  assert.equal(put.status, 405);
  assert.equal(put.json.error, 'method_not_allowed');
});
