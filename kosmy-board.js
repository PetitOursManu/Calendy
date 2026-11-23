'use strict';
/**
 * « Se connecter avec Kosmy Board » : Calendy client OpenID Connect de Kosmy Board.
 *
 * Calendy n'a pas de comptes : l'accès complet passe par le jeton CALENDY_TOKEN. Ce module ajoute une
 * **liste d'accès** : des comptes Kosmy Board admis, reconnus par leur `sub` (jamais par l'e-mail, que le Board
 * ne vérifie pas). Une connexion par le Board ouvre une session par cookie, que l'API accepte à la place du jeton.
 *
 * - Le jeton reste la clé d'administration : seul quelqu'un connecté avec le jeton règle la connexion unique,
 *   relie un compte Kosmy Board (« Relier à Kosmy Board ») ou en retire un (le jeton est alors redemandé).
 * - Une session ouverte par le Board donne accès au calendrier, jamais à ces réglages.
 * - L'admission automatique (tout compte du Board qui a l'espace Calendy est admis) est désactivée par défaut.
 * - Sans CALENDY_TOKEN, Calendy est ouvert à tous : la connexion unique n'a pas de sens et reste inactive.
 *
 * Parcours (docs/integration.md de Kosmy Board) : state, nonce et PKCE S256 ; `iss` vérifié au lancement et au
 * retour ; échange du code en client_secret_basic ; ID token RS256 vérifié avec les clés de `jwks_uri`
 * (signature, iss, aud, exp, nonce). Le state ne sert qu'une fois et il est lié au navigateur par un cookie.
 *
 * Admin dans le Board (kosmy-board-admin.js) : authentifierAdmin vérifie le jeton kb-admin+jwt avec les mêmes réglages
 * et les mêmes clés, puis retrouve le compte par son `sub` ; seul un compte de rôle « admin » est administrateur (relié
 * avec le jeton, ou nommé administrateur depuis le Board).
 *
 * Utilisateurs gérés par le Board (kosmy-board-users.js) : un administrateur du Board admet un compte (PUT), avec un rôle
 * et des restrictions, ou le désactive (DELETE). Un compte désactivé reste dans la liste mais n'entre plus : connexion
 * unique refusée, session refusée, admin dans le Board refusée. L'ID token peut porter `kosmy_board_access` : appliqué
 * à la connexion comme un PUT.
 *
 * Réglages et liste d'accès dans DATA_DIR/kosmy-board.json (fichier séparé de data.json, mode 600).
 * Le secret client n'est jamais renvoyé au navigateur.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AccesErreur, messageAcces, verifierAcces, roleDe, valeursDe, restrictionsDe, ROLE_ADMIN } = require('./kosmy-board-users.js');

const LOGIN_PATH = '/auth/kosmy-board/login';
const CALLBACK_PATH = '/auth/kosmy-board/callback';
const COOKIE_SESSION = 'calendy_kb_session';
const COOKIE_FLUX = 'calendy_kb_flux';
const DUREE_FLUX = 10 * 60 * 1000;
const DUREE_SESSION = 7 * 24 * 3600 * 1000;
const DUREE_DECOUVERTE = 60 * 60 * 1000;
const FLUX_MAX = 500;
const COMPTES_MAX = 200;
const DELAI_RESEAU = 10000;
const TOLERANCE_HORLOGE = 60; // secondes
// Admin dans le Board : jeton à usage unique, valable 60 s, 30 s de tolérance d'horloge (docs/admin-api.md du Board).
const ADMIN_TYP = 'kb-admin+jwt';
const ADMIN_TOLERANCE = 30; // secondes
const ADMIN_AGE_MAX = 120; // secondes
const ADMIN_CLES_DELAI = 60 * 1000; // une clé inconnue relit les clés du Board au plus une fois par minute

class OidcErreur extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ---------------- petits outils ---------------- */

const aleatoire = (octets = 32) => crypto.randomBytes(octets).toString('base64url');
const defiPkce = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

function egal(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Émetteur nettoyé (sans « / » final), ou null si ce n'est pas une adresse http(s) simple. */
function normaliserEmetteur(valeur) {
  const v = String(valeur ?? '').trim().replace(/\/+$/, '');
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.search || u.hash || u.username || u.password) return null;
    return v;
  } catch {
    return null;
  }
}

/** Page où arriver après la connexion : une page de Calendy (même origine) seulement, sinon l'accueil. */
function cibleSure(cible, base) {
  if (!cible) return '/';
  try {
    const u = new URL(cible, base);
    if (u.origin !== new URL(base).origin) return '/';
    const p = u.pathname + u.search;
    if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return '/';
    return p;
  } catch {
    return '/';
  }
}

/** Identifiants du client en HTTP Basic, encodés comme le veut RFC 6749 § 2.3.1. */
function enteteBasic(clientId, secret) {
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(secret)}`).toString('base64')}`;
}

function lireCookies(req) {
  const out = {};
  for (const morceau of String(req.headers.cookie || '').split(';')) {
    const i = morceau.indexOf('=');
    if (i > 0) out[morceau.slice(0, i).trim()] = morceau.slice(i + 1).trim();
  }
  return out;
}

function cookie(nom, valeur, { maxAge, secure, chemin = '/' }) {
  return `${nom}=${valeur}; Path=${chemin}; Max-Age=${Math.floor(maxAge / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function decoderPartie(partie) {
  return JSON.parse(Buffer.from(partie, 'base64url').toString('utf8'));
}

/**
 * Vérifie la signature d'un JWT du Board : RS256 seulement, avec une des clés de `jwks_uri`.
 * Renvoie { entete, charge }, ou lève une OidcErreur (code « cle » si la clé est inconnue : le Board a pu en changer).
 */
function verifierSignature(jwt, cles, nom = 'ID token') {
  const parties = String(jwt || '').split('.');
  if (parties.length !== 3) throw new OidcErreur('jeton', `${nom} illisible.`);
  let entete;
  let charge;
  try {
    entete = decoderPartie(parties[0]);
    charge = decoderPartie(parties[1]);
  } catch {
    throw new OidcErreur('jeton', `${nom} illisible.`);
  }
  if (!entete || typeof entete !== 'object' || !charge || typeof charge !== 'object') throw new OidcErreur('jeton', `${nom} illisible.`);
  if (entete.alg !== 'RS256') throw new OidcErreur('jeton', `Algorithme de signature refusé : ${entete.alg}.`);
  const rsa = (cles || []).filter((k) => k && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  const cle = entete.kid ? rsa.find((k) => k.kid === entete.kid) : rsa.length === 1 ? rsa[0] : null;
  if (!cle) throw new OidcErreur('cle', 'Clé de signature inconnue.');
  let publique;
  try {
    publique = crypto.createPublicKey({ key: { kty: cle.kty, n: cle.n, e: cle.e }, format: 'jwk' });
  } catch {
    throw new OidcErreur('jeton', 'Clé de signature illisible.');
  }
  const signee = Buffer.from(`${parties[0]}.${parties[1]}`);
  const ok = crypto.verify('RSA-SHA256', signee, publique, Buffer.from(parties[2], 'base64url'));
  if (!ok) throw new OidcErreur('jeton', `Signature de l’${nom} invalide.`);
  return { entete, charge };
}

/**
 * Vérifie l'ID token : JWT RS256 signé par une des clés du Board, puis iss, aud, exp et nonce.
 * Renvoie ses revendications, ou lève une OidcErreur.
 */
function verifierIdToken(idToken, { cles, emetteur, clientId, nonce, maintenant = Date.now() }) {
  const { charge } = verifierSignature(idToken, cles);

  if (charge.iss !== emetteur) throw new OidcErreur('jeton', 'ID token d’un autre émetteur.');
  const aud = Array.isArray(charge.aud) ? charge.aud : [charge.aud];
  if (!aud.includes(clientId)) throw new OidcErreur('jeton', 'ID token destiné à une autre appli.');
  if (aud.length > 1 && charge.azp !== clientId) throw new OidcErreur('jeton', 'ID token destiné à une autre appli.');
  const sec = Math.floor(maintenant / 1000);
  if (typeof charge.exp !== 'number' || charge.exp + TOLERANCE_HORLOGE < sec) throw new OidcErreur('jeton', 'ID token expiré.');
  if (typeof charge.iat === 'number' && charge.iat - TOLERANCE_HORLOGE > sec) throw new OidcErreur('jeton', 'ID token daté du futur.');
  if (!charge.nonce || !egal(charge.nonce, nonce)) throw new OidcErreur('jeton', 'Nonce invalide.');
  if (typeof charge.sub !== 'string' || !charge.sub) throw new OidcErreur('jeton', 'ID token sans identifiant (sub).');
  return charge;
}

/**
 * Vérifie le jeton de l'admin dans le Board (protocole kosmy.board-admin.v1, docs/admin-api.md de Kosmy Board) :
 * signature RS256 (mêmes clés que les ID tokens), `typ` = kb-admin+jwt (un ID token n'est jamais accepté ici),
 * iss, aud, exp (30 s de tolérance), âge du jeton, `htm` = méthode, chemin de `htu` terminé par le chemin demandé.
 * Le `jti` à usage unique est contrôlé par l'appelant, qui garde la mémoire des jetons déjà vus.
 * Renvoie les revendications, ou lève une OidcErreur.
 */
function verifierJetonAdmin(jeton, { cles, emetteur, clientId, methode, chemin, maintenant = Date.now() }) {
  const { entete, charge } = verifierSignature(jeton, cles, 'jeton d’admin');
  const typ = String(entete.typ || '').toLowerCase().replace(/^application\//, '');
  if (typ !== ADMIN_TYP) throw new OidcErreur('jeton', 'Ce n’est pas un jeton d’admin du Board.');
  if (charge.iss !== emetteur) throw new OidcErreur('jeton', 'Jeton d’un autre émetteur.');
  const aud = Array.isArray(charge.aud) ? charge.aud : [charge.aud];
  if (!aud.includes(clientId)) throw new OidcErreur('jeton', 'Jeton destiné à une autre appli.');
  const sec = Math.floor(maintenant / 1000);
  if (typeof charge.exp !== 'number' || charge.exp + ADMIN_TOLERANCE < sec) throw new OidcErreur('jeton', 'Jeton expiré.');
  if (typeof charge.iat !== 'number' || charge.iat - ADMIN_TOLERANCE > sec || sec - charge.iat > ADMIN_AGE_MAX + ADMIN_TOLERANCE) {
    throw new OidcErreur('jeton', 'Jeton trop ancien ou daté du futur.');
  }
  if (charge.htm !== methode) throw new OidcErreur('jeton', 'Jeton fait pour une autre méthode.');
  let htu = '';
  try { htu = new URL(charge.htu).pathname.replace(/\/+$/, ''); } catch { /* refusé juste en dessous */ }
  if (!htu || !htu.endsWith(chemin)) throw new OidcErreur('jeton', 'Jeton fait pour une autre adresse.');
  if (typeof charge.jti !== 'string' || !charge.jti || charge.jti.length > 200) throw new OidcErreur('jeton', 'Jeton sans identifiant (jti).');
  if (typeof charge.sub !== 'string' || !charge.sub) throw new OidcErreur('jeton', 'Jeton sans identifiant de compte (sub).');
  return charge;
}

/* ---------------- module ---------------- */

/**
 * @param {object} o
 * @param {string} o.dataDir dossier des données
 * @param {Function} o.HttpError erreur HTTP de Calendy
 * @param {boolean} o.jetonDefini CALENDY_TOKEN est-il défini ?
 * @param {Function} [o.fetchImpl] pour les tests
 * @param {Function} [o.maintenant] pour les tests
 */
function creerKosmyBoard({ dataDir, HttpError, jetonDefini, fetchImpl = (...a) => fetch(...a), maintenant = () => Date.now() }) {
  const fichier = path.join(dataDir, 'kosmy-board.json');
  const flux = new Map(); // state → { verifier, nonce, emetteur, cible, mode, navigateur, exp }
  const decouvertes = new Map(); // émetteur → { doc, cles, at }

  function lire() {
    let r = {};
    try { r = JSON.parse(fs.readFileSync(fichier, 'utf8')); } catch { /* premier lancement */ }
    return {
      emetteur: typeof r.emetteur === 'string' ? r.emetteur : '',
      clientId: typeof r.clientId === 'string' ? r.clientId : '',
      secret: typeof r.secret === 'string' ? r.secret : '',
      admissionAuto: r.admissionAuto === true,
      cleSession: typeof r.cleSession === 'string' ? r.cleSession : '',
      comptes: Array.isArray(r.comptes) ? r.comptes.filter((c) => c && typeof c.sub === 'string' && c.sub) : [],
    };
  }

  function ecrire(r) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${fichier}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, fichier);
  }

  const regle = (r) => Boolean(r.emetteur && r.clientId && r.secret);
  const actif = (r = lire()) => jetonDefini && regle(r);

  function cleSession(r) {
    if (!r.cleSession) {
      r.cleSession = aleatoire(32);
      ecrire(r);
    }
    return r.cleSession;
  }

  // `par` : « jeton » (relié par « Relier à Kosmy Board », avec le jeton), « admission-auto » ou « board » (admis par
  // un administrateur depuis Kosmy Board, kosmy-board-users.js). `role` : « admin » ou « member » (voir roleDe) ;
  // `actif` : faux pour un compte désactivé depuis le Board (il ne peut plus entrer) ; `restrictions` : celles qui s'appliquent.
  const comptepublic = (c) => ({
    sub: c.sub,
    nom: c.nom || '',
    email: c.email || '',
    relieLe: c.relieLe || '',
    derniereConnexion: c.derniereConnexion || '',
    par: c.par || '',
    role: roleDe(c),
    actif: !c.desactive,
    ...(c.desactive ? { desactiveLe: c.desactiveLe || '' } : {}),
    restrictions: restrictionsDe(c),
  });

  /** Réglages montrés dans l'interface (jamais le secret). */
  function publics(base) {
    const r = lire();
    return {
      emetteur: r.emetteur,
      clientId: r.clientId,
      secretDefini: Boolean(r.secret),
      admissionAuto: r.admissionAuto,
      jetonDefini,
      actif: actif(r),
      adresseRetour: `${base}${CALLBACK_PATH}`,
      adresseLancement: `${base}${LOGIN_PATH}`,
      comptes: r.comptes.map(comptepublic),
    };
  }

  function modifier(body, base) {
    if (!jetonDefini) throw new HttpError(409, 'Définis d’abord CALENDY_TOKEN sur le serveur : sans jeton, Calendy est ouvert à tous et la connexion unique n’a pas de sens.');
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Réglages attendus.');
    const r = lire();
    if (body.emetteur !== undefined) {
      if (String(body.emetteur).trim() === '') r.emetteur = '';
      else {
        const e = normaliserEmetteur(body.emetteur);
        if (!e) throw new HttpError(400, 'Émetteur : une adresse http(s) complète, par exemple https://board.mondomaine.fr/oidc.');
        r.emetteur = e;
      }
    }
    if (body.clientId !== undefined) {
      const id = String(body.clientId ?? '').trim();
      if (id.length > 200) throw new HttpError(400, 'Identifiant client trop long.');
      r.clientId = id;
    }
    // Secret en écriture seule : une chaîne vide le garde, null le retire.
    if (body.secret === null) r.secret = '';
    else if (typeof body.secret === 'string' && body.secret.trim()) {
      if (body.secret.length > 500) throw new HttpError(400, 'Secret client trop long.');
      r.secret = body.secret.trim();
    }
    if (body.admissionAuto !== undefined) r.admissionAuto = body.admissionAuto === true;
    ecrire(r);
    decouvertes.clear();
    return publics(base);
  }

  function retirer(sub, base) {
    const r = lire();
    const avant = r.comptes.length;
    r.comptes = r.comptes.filter((c) => c.sub !== sub);
    if (r.comptes.length === avant) throw new HttpError(404, 'Ce compte Kosmy Board n’est pas dans la liste.');
    ecrire(r);
    return publics(base);
  }

  /* ---------- OpenID Connect ---------- */

  async function lireJson(url, options = {}) {
    let res;
    try {
      res = await fetchImpl(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(DELAI_RESEAU) });
    } catch {
      throw new OidcErreur('reseau', 'Kosmy Board est injoignable depuis le serveur de Calendy.');
    }
    let json = null;
    try { json = await res.json(); } catch { /* corps vide ou illisible */ }
    return { ok: res.ok, status: res.status, json };
  }

  async function decouvrir(emetteur, { rafraichirCles = false } = {}) {
    let d = decouvertes.get(emetteur);
    if (!d || maintenant() - d.at > DUREE_DECOUVERTE) {
      const r = await lireJson(`${emetteur}/.well-known/openid-configuration`);
      if (!r.ok || !r.json) throw new OidcErreur('decouverte', `Découverte OpenID Connect impossible (code ${r.status}).`);
      const doc = r.json;
      if (doc.issuer !== emetteur) throw new OidcErreur('decouverte', 'L’émetteur annoncé par Kosmy Board ne correspond pas à celui réglé.');
      for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        if (typeof doc[k] !== 'string') throw new OidcErreur('decouverte', `Découverte OpenID Connect incomplète (${k}).`);
      }
      d = { doc, cles: null, at: maintenant() };
      decouvertes.set(emetteur, d);
    }
    if (!d.cles || rafraichirCles) {
      const r = await lireJson(d.doc.jwks_uri);
      if (!r.ok || !r.json || !Array.isArray(r.json.keys)) throw new OidcErreur('decouverte', 'Clés de signature de Kosmy Board introuvables.');
      d.cles = r.json.keys;
    }
    return d;
  }

  function purgerFlux() {
    const t = maintenant();
    for (const [k, v] of flux) if (v.exp < t) flux.delete(k);
    while (flux.size >= FLUX_MAX) flux.delete(flux.keys().next().value);
  }

  /**
   * Prépare la demande d'autorisation. `mode` : « connexion » (ouvre une session) ou « relier » (ajoute le compte
   * Kosmy Board à la liste d'accès : réservé à une session ouverte avec le jeton, contrôlé par l'appelant).
   * Renvoie l'adresse du Board et l'en-tête Set-Cookie qui lie ce parcours au navigateur.
   */
  async function demarrer({ base, iss, cible, mode = 'connexion' }) {
    const r = lire();
    if (!actif(r)) throw new OidcErreur('inactif', 'La connexion avec Kosmy Board n’est pas réglée dans Calendy.');
    if (iss && iss !== r.emetteur) throw new OidcErreur('emetteur', 'Cette demande vient d’un autre Kosmy Board que celui réglé dans Calendy.');
    const { doc } = await decouvrir(r.emetteur);
    purgerFlux();
    const state = aleatoire(16);
    const verifier = aleatoire(32);
    const nonce = aleatoire(16);
    const navigateur = aleatoire(16);
    flux.set(state, { verifier, nonce, emetteur: r.emetteur, cible: cibleSure(cible, base), mode, navigateur, exp: maintenant() + DUREE_FLUX });
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: r.clientId,
      redirect_uri: `${base}${CALLBACK_PATH}`,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: defiPkce(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return {
      url: url.href,
      cookie: cookie(COOKIE_FLUX, navigateur, { maxAge: DUREE_FLUX, secure: base.startsWith('https:'), chemin: '/auth/kosmy-board' }),
    };
  }

  /**
   * Retour du Board. Vérifie tout, puis relie le compte (mode « relier ») ou retrouve le compte admis
   * (mode « connexion »). Renvoie { cible, mode, compte, cookies } ou lève une OidcErreur.
   */
  async function terminer({ base, query, req }) {
    const state = String(query.state || '');
    const f = state ? flux.get(state) : null;
    if (f) flux.delete(state); // à usage unique, même en cas d'échec
    const navigateur = lireCookies(req)[COOKIE_FLUX] || '';
    if (!f || f.exp < maintenant() || !navigateur || !egal(navigateur, f.navigateur)) {
      throw new OidcErreur('state', 'Connexion expirée ou inconnue. Recommence depuis Calendy ou depuis Kosmy Board.');
    }
    if (query.error) {
      if (query.error === 'access_denied') throw new OidcErreur('refuse', 'Kosmy Board a refusé l’accès : cet espace Calendy n’est pas dans ton Board.');
      throw new OidcErreur('refuse', `Kosmy Board a refusé la connexion : ${String(query.error_description || query.error).slice(0, 200)}`);
    }
    const r = lire();
    if (!actif(r) || r.emetteur !== f.emetteur) throw new OidcErreur('inactif', 'La connexion avec Kosmy Board a changé pendant la connexion. Recommence.');
    // RFC 9207 : la réponse doit venir de l'émetteur attendu (le Board envoie toujours iss).
    if (query.iss !== undefined && query.iss !== r.emetteur) throw new OidcErreur('emetteur', 'Réponse d’un autre émetteur que celui réglé.');
    if (!query.code) throw new OidcErreur('code', 'Réponse de Kosmy Board sans code d’autorisation.');

    let d = await decouvrir(r.emetteur);
    const echange = await lireJson(d.doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: enteteBasic(r.clientId, r.secret) },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(query.code), redirect_uri: `${base}${CALLBACK_PATH}`, code_verifier: f.verifier }).toString(),
    });
    if (!echange.ok || !echange.json || typeof echange.json.id_token !== 'string') {
      const e = echange.json || {};
      const detail = e.error === 'invalid_client' ? ' Vérifie l’identifiant et le secret client.' : '';
      throw new OidcErreur('echange', `Kosmy Board a refusé l’échange du code (${e.error || echange.status}).${detail}`);
    }
    const options = { emetteur: r.emetteur, clientId: r.clientId, nonce: f.nonce, maintenant: maintenant() };
    let claims;
    try {
      claims = verifierIdToken(echange.json.id_token, { ...options, cles: d.cles });
    } catch (err) {
      if (!(err instanceof OidcErreur) || err.code !== 'cle') throw err;
      // Clé inconnue : le Board a peut-être changé de clé. On relit les clés une fois.
      d = await decouvrir(r.emetteur, { rafraichirCles: true });
      claims = verifierIdToken(echange.json.id_token, { ...options, cles: d.cles });
    }

    const nom = String(claims.name || claims.preferred_username || claims.email || '').slice(0, 120);
    const email = String(claims.email || claims.preferred_username || '').slice(0, 200);
    const date = new Date(maintenant()).toISOString();
    let compte = r.comptes.find((c) => c.sub === claims.sub);
    let nouveau = false;
    // Accès géré par le Board (docs/users-api.md) : l'ID token porte le rôle et les restrictions donnés par un
    // administrateur du Board. Mêmes règles qu'un PUT, compte créé s'il n'existe pas, jamais de liaison par l'e-mail.
    const accesBoard = claims.kosmy_board_access;
    if (f.mode === 'connexion' && accesBoard && typeof accesBoard === 'object' && !Array.isArray(accesBoard)) {
      try {
        const a = appliquerAccesDans(r, claims.sub, { name: nom, email, role: accesBoard.role, values: accesBoard.values }, { aLaConnexion: true, date });
        compte = a.compte;
        nouveau = a.status === 'created';
      } catch (err) {
        if (err instanceof AccesErreur) throw new OidcErreur('acces', messageAcces(err));
        throw err;
      }
    } else if (!compte) {
      if (f.mode !== 'relier' && !r.admissionAuto) {
        throw new OidcErreur('non_relie', 'Ce compte Kosmy Board n’est relié à aucun accès Calendy.');
      }
      if (r.comptes.length >= COMPTES_MAX) throw new OidcErreur('plein', 'La liste d’accès de Calendy est pleine.');
      compte = { sub: claims.sub, relieLe: date, par: f.mode === 'relier' ? 'jeton' : 'admission-auto' };
      r.comptes.push(compte);
      nouveau = true;
    }
    // Un compte désactivé depuis le Board n'entre plus, ni par la connexion unique, ni en le reliant à nouveau.
    if (compte.desactive) {
      throw new OidcErreur('desactive', 'Ce compte Kosmy Board a été désactivé dans Calendy. Demande à un administrateur de te redonner l’accès depuis Kosmy Board.');
    }
    // Le nom et l'e-mail ne servent qu'à l'affichage : seul `sub` identifie le compte.
    compte.nom = nom;
    compte.email = email;
    compte.derniereConnexion = date;
    ecrire(r);

    return {
      cible: f.cible,
      mode: f.mode,
      nouveau,
      compte: comptepublic(compte),
      cookies: [
        cookie(COOKIE_SESSION, signerSession(r, claims.sub), { maxAge: DUREE_SESSION, secure: base.startsWith('https:') }),
        cookie(COOKIE_FLUX, '', { maxAge: 0, secure: base.startsWith('https:'), chemin: '/auth/kosmy-board' }),
      ],
    };
  }

  /* ---------- session par cookie ---------- */

  function signerSession(r, sub) {
    const charge = Buffer.from(JSON.stringify({ sub, exp: maintenant() + DUREE_SESSION })).toString('base64url');
    const mac = crypto.createHmac('sha256', cleSession(r)).update(charge).digest('base64url');
    return `${charge}.${mac}`;
  }

  /** Le compte Kosmy Board de la session du navigateur, s'il est toujours dans la liste d'accès ; sinon null. */
  function session(req) {
    const valeur = lireCookies(req)[COOKIE_SESSION];
    if (!valeur) return null;
    const r = lire();
    if (!actif(r) || !r.cleSession) return null;
    const [charge, mac] = valeur.split('.');
    if (!charge || !mac) return null;
    const attendu = crypto.createHmac('sha256', r.cleSession).update(charge).digest('base64url');
    if (!egal(mac, attendu)) return null;
    let s;
    try { s = decoderPartie(charge); } catch { return null; }
    if (!s || typeof s.exp !== 'number' || s.exp < maintenant()) return null;
    // Un compte retiré ou désactivé perd aussitôt sa session.
    const compte = r.comptes.find((c) => c.sub === s.sub);
    return compte && !compte.desactive ? comptepublic(compte) : null;
  }

  const cookieDeconnexion = (base) => cookie(COOKIE_SESSION, '', { maxAge: 0, secure: base.startsWith('https:') });

  /* ---------- admin dans le Board ---------- */

  const jtiVus = new Map(); // jti → fin de validité (ms) : un jeton d'admin ne sert qu'une fois
  let clesRelues = 0;

  /**
   * Authentifie une requête de l'admin dans le Board : jeton (voir verifierJetonAdmin), jti jamais vu, puis
   * `sub` → compte de la liste d'accès. Renvoie { claims, compte, admin, actif } ; `admin` est vrai pour un compte actif
   * de rôle « admin » (relié avec le jeton, ou nommé administrateur depuis le Board), faux sinon.
   * Lève une OidcErreur : « inactif », « jeton », « non_relie », ou une erreur de découverte.
   */
  async function authentifierAdmin({ autorisation, methode, chemin }) {
    const r = lire();
    if (!actif(r)) throw new OidcErreur('inactif', 'La connexion avec Kosmy Board n’est pas réglée dans Calendy.');
    const m = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(String(autorisation || ''));
    if (!m) throw new OidcErreur('jeton', 'Jeton du Board absent.');
    let d = await decouvrir(r.emetteur);
    const options = { emetteur: r.emetteur, clientId: r.clientId, methode, chemin, maintenant: maintenant() };
    let claims;
    try {
      claims = verifierJetonAdmin(m[1], { ...options, cles: d.cles });
    } catch (err) {
      // Clé inconnue : le Board a peut-être changé de clé. On relit ses clés, au plus une fois par minute.
      if (!(err instanceof OidcErreur) || err.code !== 'cle' || maintenant() - clesRelues < ADMIN_CLES_DELAI) throw err;
      clesRelues = maintenant();
      d = await decouvrir(r.emetteur, { rafraichirCles: true });
      claims = verifierJetonAdmin(m[1], { ...options, cles: d.cles });
    }
    const t = maintenant();
    for (const [jti, fin] of jtiVus) if (fin < t) jtiVus.delete(jti);
    if (jtiVus.has(claims.jti)) throw new OidcErreur('jeton', 'Jeton déjà utilisé.');
    jtiVus.set(claims.jti, claims.exp * 1000 + ADMIN_TOLERANCE * 1000);

    // Le Board dit qui est la personne ; les droits, c'est Calendy qui les donne.
    const compte = r.comptes.find((c) => c.sub === claims.sub);
    if (!compte) throw new OidcErreur('non_relie', 'Ce compte Kosmy Board n’est relié à aucun accès Calendy.');
    return { claims, compte: comptepublic(compte), admin: roleDe(compte) === ROLE_ADMIN && !compte.desactive, actif: !compte.desactive };
  }

  /* ---------- utilisateurs gérés par le Board (kosmy-board-users.js) ---------- */

  const adminsActifs = (r) => r.comptes.filter((c) => roleDe(c) === ROLE_ADMIN && !c.desactive).length;

  /**
   * Admet ou met à jour le compte `sub` dans `r` (sans l'écrire) : rôle, restrictions, nom et e-mail affichés, et
   * réactivation. Appelée par un PUT du Board (moi = la personne qui agit) et à la connexion quand l'ID token porte
   * `kosmy_board_access` (aLaConnexion). Calendy n'a pas de compte hors de la liste d'accès : il n'y a jamais rien à
   * « relier » par l'e-mail ; une adresse déjà portée par un autre compte admis est refusée (409) dans un PUT.
   * Renvoie { status: 'created' | 'updated', compte }, ou lève une AccesErreur.
   */
  function appliquerAccesDans(r, sub, corps, { moi = null, aLaConnexion = false, date = new Date(maintenant()).toISOString() } = {}) {
    let compte = r.comptes.find((c) => c.sub === sub);
    const { role, valeurs } = verifierAcces(corps, compte ? valeursDe(compte) : null);
    const nom = typeof corps.name === 'string' && corps.name.trim() ? corps.name.trim().slice(0, 120) : '';
    const brut = typeof corps.email === 'string' ? corps.email.trim().slice(0, 200) : '';
    const email = /^[^\s@]+@[^\s@]+$/.test(brut) ? brut : '';
    let status = 'updated';
    let roleFinal = role;
    if (!compte) {
      if (!aLaConnexion && email) {
        const autre = r.comptes.find((c) => c.email && c.email.toLowerCase() === email.toLowerCase());
        if (autre) throw new AccesErreur(409, 'conflict', 'err.email', { compte: autre.nom || autre.email });
      }
      if (r.comptes.length >= COMPTES_MAX) throw new AccesErreur(409, 'conflict', 'err.plein', { n: COMPTES_MAX });
      compte = { sub, nom: nom || email, email, relieLe: date, par: 'board' };
      r.comptes.push(compte);
      status = 'created';
    } else {
      // Ne pas se couper l'accès : jamais ses propres droits d'administration, jamais le dernier administrateur actif.
      const perdAdmin = !compte.desactive && roleDe(compte) === ROLE_ADMIN && role !== ROLE_ADMIN;
      if (perdAdmin && sub === moi) throw new AccesErreur(409, 'conflict', 'err.soiAdmin');
      if (perdAdmin && adminsActifs(r) <= 1) {
        if (!aLaConnexion) throw new AccesErreur(409, 'conflict', 'err.dernierAdmin');
        // À la connexion, personne à qui répondre 409 : le dernier administrateur garde son rôle, le reste s'applique.
        console.warn(`Kosmy Board : ${sub} reste administrateur de Calendy (dernier administrateur actif).`);
        roleFinal = ROLE_ADMIN;
      }
      if (nom) compte.nom = nom;
      if (email) compte.email = email;
    }
    compte.role = roleFinal;
    compte.valeurs = valeurs;
    delete compte.desactive;
    delete compte.desactiveLe;
    return { status, compte };
  }

  /** PUT /api/kosmy-board/users/{sub} : appliquerAccesDans, puis écriture. */
  function appliquerAcces(sub, corps, { moi = null } = {}) {
    const r = lire();
    const { status, compte } = appliquerAccesDans(r, sub, corps, { moi });
    ecrire(r);
    return { status, compte: comptepublic(compte) };
  }

  /**
   * DELETE /api/kosmy-board/users/{sub} : désactive le compte (il reste dans la liste, avec son rôle et ses restrictions,
   * pour être réactivé par un PUT). Sa session cesse aussitôt (session() refuse un compte désactivé).
   * Renvoie true si un compte a été désactivé, false s'il n'y avait rien à faire ; lève une AccesErreur (409).
   */
  function desactiver(sub, { moi = null } = {}) {
    const r = lire();
    const compte = r.comptes.find((c) => c.sub === sub);
    if (!compte || compte.desactive) return false;
    if (sub === moi) throw new AccesErreur(409, 'conflict', 'err.soi');
    if (roleDe(compte) === ROLE_ADMIN && adminsActifs(r) <= 1) throw new AccesErreur(409, 'conflict', 'err.dernierAdmin');
    compte.desactive = true;
    compte.desactiveLe = new Date(maintenant()).toISOString();
    ecrire(r);
    return true;
  }

  /** Les comptes de la liste d'accès, au format du protocole kosmy.board-users.v1. */
  function utilisateurs() {
    return lire().comptes.map((c) => ({
      sub: c.sub,
      role: roleDe(c),
      values: valeursDe(c),
      active: !c.desactive,
      ...(c.email || c.nom ? { account: c.email || c.nom } : {}),
    }));
  }

  return { publics, modifier, retirer, demarrer, terminer, session, cookieDeconnexion, authentifierAdmin, appliquerAcces, desactiver, utilisateurs, actif: () => actif() };
}

module.exports = { creerKosmyBoard, verifierIdToken, verifierJetonAdmin, normaliserEmetteur, cibleSure, enteteBasic, defiPkce, OidcErreur, LOGIN_PATH, CALLBACK_PATH, COOKIE_SESSION, COOKIE_FLUX };
