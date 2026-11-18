'use strict';
/**
 * Connexion avec Kosmy Board : vérification de l'ID token, outils, puis le parcours complet
 * face à un faux Kosmy Board (fournisseur OpenID Connect minimal lancé par le test).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifierIdToken, normaliserEmetteur, cibleSure, enteteBasic, defiPkce, OidcErreur } = require('../kosmy-board.js');

/* ---------------- clés et jetons de test ---------------- */

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const autre = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'cle-1', use: 'sig', alg: 'RS256' };

function signer(charge, { kid = 'cle-1', alg = 'RS256', cle = privateKey } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const entete = b64({ alg, typ: 'JWT', kid });
  const corps = b64(charge);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${entete}.${corps}`), cle).toString('base64url');
  return `${entete}.${corps}.${sig}`;
}

const maintenant = Date.now();
const sec = Math.floor(maintenant / 1000);
const base = { iss: 'https://board.test/oidc', aud: 'client-1', sub: 'sub-1', nonce: 'n-1', iat: sec, exp: sec + 300 };
const opts = { cles: [JWK], emetteur: 'https://board.test/oidc', clientId: 'client-1', nonce: 'n-1', maintenant };

function refuse(fn, code) {
  assert.throws(fn, (err) => err instanceof OidcErreur && (!code || err.code === code));
}

test('ID token valide : revendications renvoyées', () => {
  assert.equal(verifierIdToken(signer(base), opts).sub, 'sub-1');
  assert.equal(verifierIdToken(signer({ ...base, aud: ['client-1'] }), opts).sub, 'sub-1');
});

test('ID token refusé : signature, algorithme, clé, iss, aud, exp, nonce', () => {
  refuse(() => verifierIdToken(signer(base, { cle: autre.privateKey }), opts));
  refuse(() => verifierIdToken(signer(base, { alg: 'HS256' }), opts));
  refuse(() => verifierIdToken(`${signer(base).split('.').slice(0, 2).join('.')}.`, opts));
  refuse(() => verifierIdToken(signer(base, { kid: 'inconnue' }), opts), 'cle');
  refuse(() => verifierIdToken(signer({ ...base, iss: 'https://autre.test/oidc' }), opts));
  refuse(() => verifierIdToken(signer({ ...base, aud: 'autre-client' }), opts));
  refuse(() => verifierIdToken(signer({ ...base, aud: ['client-1', 'autre'] }), opts));
  refuse(() => verifierIdToken(signer({ ...base, exp: sec - 3600 }), opts));
  refuse(() => verifierIdToken(signer({ ...base, nonce: 'autre' }), opts));
  refuse(() => verifierIdToken(signer({ ...base, nonce: undefined }), opts));
  refuse(() => verifierIdToken(signer({ ...base, sub: '' }), opts));
  refuse(() => verifierIdToken('pas-un-jwt', opts));
});

test('outils : émetteur, page cible, en-tête Basic, PKCE', () => {
  assert.equal(normaliserEmetteur(' https://board.test/oidc/ '), 'https://board.test/oidc');
  assert.equal(normaliserEmetteur('ftp://board.test'), null);
  assert.equal(normaliserEmetteur('https://board.test/oidc?x=1'), null);
  assert.equal(normaliserEmetteur('pas une adresse'), null);

  const b = 'http://calendy.test';
  assert.equal(cibleSure('http://calendy.test/?vue=1', b), '/?vue=1');
  assert.equal(cibleSure('/reglages', b), '/reglages');
  assert.equal(cibleSure('https://ailleurs.test/', b), '/');
  assert.equal(cibleSure('//ailleurs.test/x', b), '/');
  assert.equal(cibleSure('javascript:alert(1)', b), '/');
  assert.equal(cibleSure('', b), '/');

  assert.equal(enteteBasic('id:1', 'sé cret'), `Basic ${Buffer.from('id%3A1:s%C3%A9+cret').toString('base64')}`);
  // Exemple de la RFC 7636, annexe B.
  assert.equal(defiPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

/* ---------------- parcours complet ---------------- */

const TOKEN = 'jeton-kosmy-test-0123456789';
const PORT = 3990 + Math.floor(Math.random() * 9);
const APP = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;
let board;
let EMETTEUR;
const SECRET = 'secret client:é';
const codes = new Map(); // code → { challenge, nonce, sub, clientId, redirectUri }
const echanges = []; // ce que le faux Board a reçu sur token_endpoint

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
      echanges.push({ authorization: req.headers.authorization, form: Object.fromEntries(f) });
      const c = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (req.headers.authorization !== enteteBasic('client-cal', SECRET)) return json(401, { error: 'invalid_client' });
      if (!c || f.get('grant_type') !== 'authorization_code' || f.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'invalid_grant' });
      if (defiPkce(f.get('code_verifier') || '') !== c.challenge) return json(400, { error: 'invalid_grant' });
      const t = Math.floor(Date.now() / 1000);
      const id_token = signer({ iss: EMETTEUR, aud: 'client-cal', sub: c.sub, nonce: c.nonce, iat: t, exp: t + 300, name: c.nom, email: c.email, email_verified: false });
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token });
    }
    json(404, { error: 'introuvable' });
  });
  return new Promise((resolve) => board.listen(0, '127.0.0.1', () => {
    EMETTEUR = `http://127.0.0.1:${board.address().port}/oidc`;
    resolve();
  }));
}

/** Ce que ferait le Board : accepter la demande d'autorisation et rendre un code pour ce compte. */
function autoriser(location, { sub = 'sub-alice', nom = 'Alice', email = 'alice@exemple.fr' } = {}) {
  const u = new URL(location);
  assert.equal(u.origin + u.pathname, `${EMETTEUR}/auth`);
  const p = u.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), 'client-cal');
  assert.equal(p.get('scope'), 'openid profile email');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.ok(p.get('state').length >= 22 && p.get('nonce').length >= 22);
  assert.equal(p.get('redirect_uri'), `${APP}/auth/kosmy-board/callback`);
  const code = crypto.randomBytes(12).toString('hex');
  codes.set(code, { challenge: p.get('code_challenge'), nonce: p.get('nonce'), sub, nom, email, redirectUri: p.get('redirect_uri') });
  return { code, state: p.get('state') };
}

const cookiesDe = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

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

async function retour({ code, state }, cookie, iss = EMETTEUR) {
  const q = new URLSearchParams({ code, state, ...(iss ? { iss } : {}) });
  return appel('GET', `/auth/kosmy-board/callback?${q}`, { token: '', cookie });
}

before(async () => {
  await demarrerBoard();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-kosmy-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CALENDY_TOKEN: TOKEN, CALENDY_NO_SEED: '1', CALENDY_PUBLIC_URL: APP },
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

test('réglages : réservés au jeton, secret jamais renvoyé', async () => {
  assert.equal((await appel('GET', '/api/kosmy-board/etat', { token: '' })).json.actif, false);
  assert.equal((await appel('GET', '/api/kosmy-board/reglages', { token: '' })).status, 401);
  // Pas encore réglé : le lancement explique, sans rediriger.
  assert.equal((await appel('GET', '/auth/kosmy-board/login', { token: '' })).status, 400);

  assert.equal((await appel('PUT', '/api/kosmy-board/reglages', { body: { emetteur: 'pas une adresse' } })).status, 400);
  const r = await appel('PUT', '/api/kosmy-board/reglages', { body: { emetteur: `${EMETTEUR}/`, clientId: 'client-cal', secret: SECRET } });
  assert.equal(r.status, 200);
  assert.equal(r.json.emetteur, EMETTEUR);
  assert.equal(r.json.secretDefini, true);
  assert.equal(r.json.admissionAuto, false);
  assert.equal(r.json.actif, true);
  assert.equal(r.json.adresseRetour, `${APP}/auth/kosmy-board/callback`);
  assert.equal(r.json.adresseLancement, `${APP}/auth/kosmy-board/login`);
  assert.ok(!JSON.stringify(r.json).includes(SECRET));
  // Une chaîne vide garde le secret.
  assert.equal((await appel('PUT', '/api/kosmy-board/reglages', { body: { secret: '' } })).json.secretDefini, true);
  assert.equal((await appel('GET', '/api/kosmy-board/etat', { token: '' })).json.actif, true);
  // Le fichier des réglages n'est pas dans data.json.
  assert.ok(!fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8').includes(SECRET));
});

test('lancement : iss vérifié, page cible de Calendy seulement', async () => {
  const mauvais = await appel('GET', `/auth/kosmy-board/login?iss=${encodeURIComponent('https://autre.test/oidc')}`, { token: '' });
  assert.equal(mauvais.status, 400);
  const r = await appel('GET', `/auth/kosmy-board/login?iss=${encodeURIComponent(EMETTEUR)}&target_link_uri=${encodeURIComponent('https://ailleurs.test/vol')}`, { token: '' });
  assert.equal(r.status, 303);
  assert.ok(r.res.headers.get('set-cookie').includes('HttpOnly'));
  assert.ok(r.res.headers.get('set-cookie').includes('SameSite=Lax'));
});

test('compte non relié : refusé, jamais retrouvé par l’e-mail', async () => {
  const r = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  const flux = cookiesDe(r.res).join('; ');
  const fin = await retour(autoriser(r.res.headers.get('location')), flux);
  assert.equal(fin.status, 403);
  assert.ok(fin.texte.includes('n’est relié à aucun accès Calendy'));
  assert.equal(cookiesDe(fin.res).length, 0);
});

let session = '';

test('Relier à Kosmy Board depuis une session avec le jeton, puis connexion par le Board', async () => {
  // Une session ouverte par le Board ne peut pas relier : il faut le jeton.
  assert.equal((await appel('POST', '/api/kosmy-board/relier', { body: {}, token: '' })).status, 401);
  const r = await appel('POST', '/api/kosmy-board/relier', { body: {} });
  assert.equal(r.status, 200);
  const flux = cookiesDe(r.res).join('; ');
  const fin = await retour(autoriser(r.json.url), flux);
  assert.equal(fin.status, 303);
  assert.equal(fin.res.headers.get('location'), '/?kosmy=relie');
  // Échange du code : client_secret_basic, PKCE, rien dans le corps.
  const e = echanges.at(-1);
  assert.equal(e.authorization, enteteBasic('client-cal', SECRET));
  assert.equal(e.form.client_secret, undefined);
  assert.ok(e.form.code_verifier);

  const reglages = (await appel('GET', '/api/kosmy-board/reglages')).json;
  assert.equal(reglages.comptes.length, 1);
  assert.equal(reglages.comptes[0].sub, 'sub-alice');
  assert.equal(reglages.comptes[0].nom, 'Alice');

  // « Ouvrir » depuis le Board : iss + target_link_uri de Calendy.
  const l = await appel('GET', `/auth/kosmy-board/login?iss=${encodeURIComponent(EMETTEUR)}&target_link_uri=${encodeURIComponent(`${APP}/?depuis=board`)}`, { token: '' });
  const fin2 = await retour(autoriser(l.res.headers.get('location')), cookiesDe(l.res).join('; '));
  assert.equal(fin2.status, 303);
  assert.equal(fin2.res.headers.get('location'), '/?depuis=board');
  session = cookiesDe(fin2.res).find((c) => c.startsWith('calendy_kb_session='));
  assert.ok(session);
  assert.ok(fin2.res.headers.getSetCookie().find((c) => c.startsWith('calendy_kb_session=')).includes('HttpOnly'));
});

test('session du Board : le calendrier oui, les réglages de connexion non', async () => {
  assert.equal((await appel('GET', '/api/state', { token: '' })).status, 401);
  assert.equal((await appel('GET', '/api/state', { token: '', cookie: session })).status, 200);
  const s = (await appel('GET', '/api/session', { token: '', cookie: session })).json;
  assert.equal(s.acces, 'kosmy');
  assert.equal(s.compte.sub, 'sub-alice');
  assert.equal((await appel('GET', '/api/kosmy-board/reglages', { token: '', cookie: session })).status, 403);
  assert.equal((await appel('PUT', '/api/kosmy-board/reglages', { token: '', cookie: session, body: { admissionAuto: true } })).status, 403);
  assert.equal((await appel('POST', '/api/kosmy-board/retirer', { token: '', cookie: session, body: { sub: 'sub-alice', jeton: TOKEN } })).status, 403);
  // Un cookie trafiqué ne passe pas.
  const [charge, mac] = session.split('=')[1].split('.');
  const faux = Buffer.from(JSON.stringify({ sub: 'sub-alice', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal((await appel('GET', '/api/state', { token: '', cookie: `calendy_kb_session=${faux}.${mac}` })).status, 401);
  assert.equal((await appel('GET', '/api/state', { token: '', cookie: `calendy_kb_session=${charge}.x${mac}` })).status, 401);
});

test('retour : state à usage unique, lié au navigateur, iss vérifié', async () => {
  const r = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  const flux = cookiesDe(r.res).join('; ');
  const a = autoriser(r.res.headers.get('location'));
  // Sans le cookie du navigateur qui a lancé la connexion : refusé (et le state est consommé).
  assert.equal((await retour(a, '')).status, 400);
  assert.equal((await retour(a, flux)).status, 400);

  const r2 = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  const flux2 = cookiesDe(r2.res).join('; ');
  const b = autoriser(r2.res.headers.get('location'));
  assert.equal((await retour(b, flux2, 'https://autre.test/oidc')).status, 400);

  const r3 = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  const flux3 = cookiesDe(r3.res).join('; ');
  const c = autoriser(r3.res.headers.get('location'));
  assert.equal((await retour(c, flux3)).status, 303);
  assert.equal((await retour(c, flux3)).status, 400); // rejouer le même retour

  // Le Board refuse (espace absent de son Board).
  const r4 = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  const d = autoriser(r4.res.headers.get('location'));
  const refus = await appel('GET', `/auth/kosmy-board/callback?error=access_denied&state=${d.state}&iss=${encodeURIComponent(EMETTEUR)}`, { token: '', cookie: cookiesDe(r4.res).join('; ') });
  assert.equal(refus.status, 403);
});

test('admission automatique (désactivée par défaut) : un compte inconnu entre, sans droits sur les réglages', async () => {
  assert.equal((await appel('PUT', '/api/kosmy-board/reglages', { body: { admissionAuto: true } })).json.admissionAuto, true);
  const r = await appel('GET', '/auth/kosmy-board/login', { token: '' });
  const fin = await retour(autoriser(r.res.headers.get('location'), { sub: 'sub-bob', nom: 'Bob', email: 'alice@exemple.fr' }), cookiesDe(r.res).join('; '));
  assert.equal(fin.status, 303);
  const bob = cookiesDe(fin.res).find((c) => c.startsWith('calendy_kb_session='));
  assert.equal((await appel('GET', '/api/session', { token: '', cookie: bob })).json.compte.sub, 'sub-bob');
  assert.equal((await appel('GET', '/api/kosmy-board/reglages', { token: '', cookie: bob })).status, 403);
  // Même e-mail qu'Alice, mais un autre compte : deux entrées distinctes.
  assert.equal((await appel('GET', '/api/kosmy-board/reglages')).json.comptes.length, 2);
  await appel('PUT', '/api/kosmy-board/reglages', { body: { admissionAuto: false } });
});

test('retirer un compte demande le jeton et ferme sa session', async () => {
  assert.equal((await appel('POST', '/api/kosmy-board/retirer', { body: { sub: 'sub-alice', jeton: 'mauvais' } })).status, 403);
  assert.equal((await appel('POST', '/api/kosmy-board/retirer', { body: { sub: 'sub-alice' } })).status, 403);
  const r = await appel('POST', '/api/kosmy-board/retirer', { body: { sub: 'sub-alice', jeton: TOKEN } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.comptes.map((c) => c.sub), ['sub-bob']);
  assert.equal((await appel('GET', '/api/state', { token: '', cookie: session })).status, 401);
});

test('déconnexion : le cookie de session est effacé', async () => {
  const r = await appel('POST', '/api/kosmy-board/deconnexion', { body: {} });
  assert.equal(r.status, 200);
  assert.ok(r.res.headers.get('set-cookie').startsWith('calendy_kb_session=;'));
  assert.ok(r.res.headers.get('set-cookie').includes('Max-Age=0'));
});
