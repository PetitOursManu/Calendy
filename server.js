'use strict';
/**
 * Calendy — calendrier éditorial des réseaux sociaux (ESAT Elisa 30)
 *
 * Serveur Node sans framework :
 *   - API REST JSON sous /api (posts, événements, export Excel)
 *   - sert l'interface (public/index.html)
 *   - stockage dans un simple fichier data.json (sauvegarde .bak à chaque écriture)
 *
 * Variables d'environnement :
 *   PORT           port d'écoute (défaut 3000)
 *   HOST           adresse d'écoute (défaut 127.0.0.1 ; 0.0.0.0 dans Docker)
 *   DATA_DIR       dossier de stockage (défaut ./data)
 *   CALENDY_TOKEN  jeton d'accès à l'API (optionnel mais recommandé hors poste local)
 *   CALENDY_NO_SEED=1  ne pas charger seed.json au premier démarrage
 *
 * Les photos des posts sont rangées dans DATA_DIR/images (à sauvegarder avec data.json).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

/**
 * Nettoie un jeton : retire les espaces et retours à la ligne aux extrémités, puis une paire de
 * guillemets qui entourerait toute la valeur. Les hébergeurs (Coolify, fichiers .env…) laissent
 * parfois traîner ces caractères, invisibles à l'œil, qui rendaient le bon jeton « incorrect ».
 */
function nettoyerJeton(valeur) {
  let t = String(valeur ?? '').trim();
  const entoure = t.match(/^(["'])([\s\S]*)\1$/);
  if (entoure) t = entoure[2].trim();
  return t;
}

const TOKEN_BRUT = process.env.CALENDY_TOKEN || '';
const TOKEN = nettoyerJeton(TOKEN_BRUT);
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const STATUTS = ['idee', 'valide', 'refuse', 'publie'];
const STATUT_LIBELLES = {
  idee: 'Idée à valider',
  valide: 'Validé',
  refuse: 'Refusé',
  publie: 'Publié',
};
const PLATEFORMES = ['Instagram', 'Facebook', 'LinkedIn'];

/* ------------------------------------------------------------------ */
/* Erreurs et validation                                              */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function str(value, label, { max = 2000, required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `Le champ « ${label} » doit être un texte.`);
  const v = value.replace(/\r\n?/g, '\n').trim();
  if (required && !v) throw new HttpError(400, `Le champ « ${label} » est obligatoire.`);
  if (v.length > max) throw new HttpError(400, `Le champ « ${label} » dépasse ${max} caractères.`);
  return v;
}

function date(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `Le champ « ${label} » est obligatoire (format AAAA-MM-JJ).`);
    return '';
  }
  if (!isValidDate(value)) throw new HttpError(400, `« ${label} » doit être une date valide au format AAAA-MM-JJ.`);
  return value;
}

function heure(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new HttpError(400, '« heure » doit être au format HH:MM (ex. 11:30).');
  }
  return value;
}

function hashtags(value) {
  if (value === undefined || value === null || value === '') return '';
  const raw = Array.isArray(value) ? value.join(' ') : value;
  if (typeof raw !== 'string') throw new HttpError(400, 'Le champ « hashtags » doit être un texte ou une liste.');
  const tokens = raw
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));
  const out = [...new Set(tokens)].join(' ');
  if (out.length > 1000) throw new HttpError(400, 'Le champ « hashtags » est trop long.');
  return out;
}

function plateformes(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[+,;]/) : null;
  if (!list) throw new HttpError(400, 'Le champ « plateformes » doit être une liste (Instagram, Facebook, LinkedIn).');
  const out = [];
  for (const item of list) {
    const name = String(item).trim();
    if (!name) continue;
    const canonical = PLATEFORMES.find((p) => p.toLowerCase() === name.toLowerCase());
    if (!canonical) throw new HttpError(400, `Réseau inconnu : « ${name} ». Valeurs possibles : ${PLATEFORMES.join(', ')}.`);
    if (!out.includes(canonical)) out.push(canonical);
  }
  if (!out.length) throw new HttpError(400, 'Choisis au moins un réseau.');
  return PLATEFORMES.filter((p) => out.includes(p));
}

function statut(value) {
  if (!STATUTS.includes(value)) {
    throw new HttpError(400, `Statut invalide : « ${value} ». Valeurs possibles : ${STATUTS.join(', ')}.`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Photos                                                             */
/* ------------------------------------------------------------------ */

// Une photo facultative par « visuel » : Instagram et Facebook partagent la même, LinkedIn a la sienne.
const PHOTO_SLOTS = ['meta', 'linkedin'];
const PHOTO_MAX = 8 * 1024 * 1024;

/** Reconnaît un JPEG ou un PNG d'après son contenu (pas d'après ce que dit le client) et lit ses dimensions. */
function lireImage(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'image/png', ext: 'png', largeur: buf.readUInt32BE(16), hauteur: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: 'image/jpeg', ext: 'jpg', hauteur: buf.readUInt16BE(i + 5), largeur: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

const photosVides = () => ({ meta: null, linkedin: null });

function normaliserPhotos(photos) {
  const out = photosVides();
  for (const slot of PHOTO_SLOTS) {
    const f = photos && photos[slot];
    if (f && typeof f.fichier === 'string' && /^[\w.-]+$/.test(f.fichier)) out[slot] = f;
  }
  return out;
}

const cheminPhoto = (fichier) => path.join(IMAGES_DIR, path.basename(fichier));

function supprimerFichierPhoto(photo) {
  if (!photo) return;
  try {
    fs.unlinkSync(cheminPhoto(photo.fichier));
  } catch {
    /* déjà absent */
  }
}

function lireCorpsBrut(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tropLourd = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > max * 4) return req.destroy(); // abus manifeste : on coupe
      if (size > max) tropLourd = true; // on laisse finir l'envoi pour pouvoir répondre proprement
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tropLourd) reject(new HttpError(413, `Photo trop lourde (maximum ${Math.round(max / 1048576)} Mo).`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function enregistrerPhoto(req, id, slot) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png') {
    throw new HttpError(415, 'Content-Type image/jpeg ou image/png requis.');
  }
  if (!db.posts.some((p) => p.id === id)) throw new HttpError(404, 'Post introuvable.');
  const buf = await lireCorpsBrut(req, PHOTO_MAX);
  const info = lireImage(buf);
  if (!info || info.type !== type || !info.largeur || !info.hauteur || info.largeur > 20000 || info.hauteur > 20000) {
    throw new HttpError(400, 'Le fichier n’est pas une image JPEG ou PNG valide.');
  }
  const post = db.posts.find((p) => p.id === id);
  if (!post) throw new HttpError(404, 'Post introuvable.');
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const fichier = `${id}-${slot}-${crypto.randomBytes(3).toString('hex')}.${info.ext}`;
  const tmp = `${cheminPhoto(fichier)}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, cheminPhoto(fichier));
  post.photos = normaliserPhotos(post.photos);
  const ancienne = post.photos[slot];
  post.photos[slot] = { fichier, type: info.type, largeur: info.largeur, hauteur: info.hauteur, octets: buf.length };
  saveDb();
  supprimerFichierPhoto(ancienne);
  return post;
}

/* ------------------------------------------------------------------ */
/* Stockage                                                           */
/* ------------------------------------------------------------------ */

let db = { evenements: [], posts: [] };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = {
      evenements: Array.isArray(parsed.evenements) ? parsed.evenements : [],
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
    };
    db.posts.forEach((p) => { p.photos = normaliserPhotos(p.photos); });
    return;
  }
  const seedFile = path.join(__dirname, 'seed.json');
  if (!process.env.CALENDY_NO_SEED && fs.existsSync(seedFile)) {
    db = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    db.posts.forEach((p) => { p.photos = normaliserPhotos(p.photos); });
    saveDb();
    console.log(`Premier démarrage : ${db.posts.length} posts et ${db.evenements.length} événements chargés depuis seed.json`);
  } else {
    saveDb();
  }
}

function saveDb() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, `${DATA_FILE}.bak`);
  fs.renameSync(tmp, DATA_FILE);
}

const newId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;

const byDate = (a, b) =>
  (a.datePublication || '').localeCompare(b.datePublication || '') ||
  (a.heure || '').localeCompare(b.heure || '') ||
  (a.titre || '').localeCompare(b.titre || '');

/* ------------------------------------------------------------------ */
/* Événements                                                         */
/* ------------------------------------------------------------------ */

function cleanEvent(input, current = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Corps JSON attendu.');
  const out = current ? { ...current } : { explication: '', lienElisa30: '' };
  if (!current || has(input, 'nom')) out.nom = str(input.nom, 'nom', { required: true, max: 200 });
  if (!current || has(input, 'dateDebut')) out.dateDebut = date(input.dateDebut, 'dateDebut', { required: true });
  if (has(input, 'dateFin') || !current) out.dateFin = date(input.dateFin, 'dateFin') || out.dateDebut;
  if (!out.dateFin) out.dateFin = out.dateDebut;
  if (out.dateFin < out.dateDebut) throw new HttpError(400, 'La date de fin est avant la date de début.');
  if (has(input, 'explication')) out.explication = str(input.explication, 'explication', { max: 3000 });
  if (has(input, 'lienElisa30')) out.lienElisa30 = str(input.lienElisa30, 'lienElisa30', { max: 2000 });
  return out;
}

/* ------------------------------------------------------------------ */
/* Posts                                                              */
/* ------------------------------------------------------------------ */

function cleanPost(input, current = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Corps JSON attendu.');
  const out = current
    ? { ...current }
    : {
        eventId: null,
        description: '',
        hashtags: '',
        imageIdee: '',
        heure: '',
        atelier: '',
        angle: '',
        vigilance: '',
        statut: 'idee',
        photos: photosVides(),
      };
  if (!current || has(input, 'titre')) out.titre = str(input.titre, 'titre', { required: true, max: 200 });
  if (!current || has(input, 'datePublication')) {
    out.datePublication = date(input.datePublication, 'datePublication', { required: true });
  }
  if (!current || has(input, 'plateformes')) out.plateformes = plateformes(input.plateformes);
  if (has(input, 'description')) out.description = str(input.description, 'description', { max: 5000 });
  if (has(input, 'hashtags')) out.hashtags = hashtags(input.hashtags);
  if (has(input, 'imageIdee')) out.imageIdee = str(input.imageIdee, 'imageIdee', { max: 1000 });
  if (has(input, 'heure')) out.heure = heure(input.heure);
  if (has(input, 'atelier')) out.atelier = str(input.atelier, 'atelier', { max: 200 });
  if (has(input, 'angle')) out.angle = str(input.angle, 'angle', { max: 1000 });
  if (has(input, 'vigilance')) out.vigilance = str(input.vigilance, 'vigilance', { max: 2000 });
  if (has(input, 'statut')) out.statut = statut(input.statut);
  if (has(input, 'eventId')) {
    const id = input.eventId || null;
    if (id && !db.evenements.some((e) => e.id === id)) throw new HttpError(400, `Événement introuvable : ${id}`);
    out.eventId = id;
  }
  return out;
}

function filterPosts(query) {
  let list = db.posts;
  if (query.statut) {
    const wanted = query.statut.split(',').map((s) => s.trim()).filter(Boolean);
    wanted.forEach(statut);
    list = list.filter((p) => wanted.includes(p.statut));
  }
  if (query.du) list = list.filter((p) => p.datePublication >= date(query.du, 'du'));
  if (query.au) list = list.filter((p) => p.datePublication <= date(query.au, 'au'));
  if (query.eventId) list = list.filter((p) => p.eventId === query.eventId);
  if (query.q) {
    const q = query.q.toLowerCase();
    list = list.filter((p) =>
      [p.titre, p.description, p.hashtags, p.imageIdee, p.atelier, p.angle, p.vigilance]
        .join('\n')
        .toLowerCase()
        .includes(q),
    );
  }
  return [...list].sort(byDate);
}

/* ------------------------------------------------------------------ */
/* Cloner et fusionner des posts                                      */
/* ------------------------------------------------------------------ */

const CLONE_MAX_DATES = 60;

/** Copie les fichiers photo d'un post pour son clone : chaque post garde ses propres fichiers, supprimer l'un ne touche pas l'autre. */
function copierPhotos(photos, idClone) {
  const out = photosVides();
  const crees = [];
  const source = normaliserPhotos(photos);
  for (const slot of PHOTO_SLOTS) {
    const f = source[slot];
    if (!f) continue;
    const fichier = `${idClone}-${slot}-${crypto.randomBytes(3).toString('hex')}${path.extname(f.fichier) || '.jpg'}`;
    try {
      fs.copyFileSync(cheminPhoto(f.fichier), cheminPhoto(fichier));
    } catch {
      continue; // fichier d'origine absent : le clone n'a simplement pas cette photo
    }
    out[slot] = { ...f, fichier };
    crees.push(fichier);
  }
  return { photos: out, crees };
}

/** Une copie du post par date demandée. Les copies repartent en « idée à valider » : c'est l'utilisateur qui décide. */
function clonerPost(id, body) {
  const source = db.posts.find((p) => p.id === id);
  if (!source) throw new HttpError(404, 'Post introuvable.');
  if (!body || !Array.isArray(body.dates) || !body.dates.length) {
    throw new HttpError(400, 'Champ « dates » attendu : une liste de dates au format AAAA-MM-JJ.');
  }
  const dates = [...new Set(body.dates.map((d) => date(d, 'dates', { required: true })))].sort();
  if (dates.length > CLONE_MAX_DATES) throw new HttpError(400, `Maximum ${CLONE_MAX_DATES} dates à la fois.`);
  const clones = [];
  const fichiers = [];
  try {
    for (const d of dates) {
      const idClone = newId('po');
      const { photos, crees } = copierPhotos(source.photos, idClone);
      fichiers.push(...crees);
      clones.push({ ...source, id: idClone, datePublication: d, plateformes: [...source.plateformes], statut: 'idee', photos });
    }
    db.posts.push(...clones);
    saveDb();
  } catch (err) {
    db.posts = db.posts.filter((p) => !clones.includes(p));
    fichiers.forEach((f) => supprimerFichierPhoto({ fichier: f }));
    throw err;
  }
  return { status: 201, body: { clones } };
}

const CHAMPS_FUSION = ['titre', 'datePublication', 'heure', 'description', 'hashtags', 'imageIdee', 'eventId', 'atelier', 'angle', 'vigilance', 'statut'];
const estVide = (v) => v === undefined || v === null || v === '';

/**
 * Fusionne deux posts qui n'ont aucun réseau en commun (typiquement un Instagram et un Facebook) en un seul,
 * prévu sur l'union de leurs réseaux. Le post `garder` (le premier par défaut) conserve son identifiant, l'autre est supprimé.
 * Pour chaque champ, `choix[champ]` désigne le post dont on prend la valeur ; sans choix, on prend celle du post gardé,
 * ou celle de l'autre quand le post gardé n'a rien. `choix.photo` règle la photo Instagram + Facebook (id d'un post, ou « aucune »).
 * Si les statuts diffèrent et qu'aucun n'est choisi, le post fusionné repart en « idée à valider ».
 */
function fusionnerPosts(body) {
  if (!body || !Array.isArray(body.ids) || body.ids.length !== 2 || body.ids[0] === body.ids[1]) {
    throw new HttpError(400, 'Champ « ids » : indique exactement deux posts différents.');
  }
  const [a, b] = body.ids.map((id) => {
    const p = db.posts.find((x) => x.id === id);
    if (!p) throw new HttpError(404, `Post introuvable : ${id}`);
    return p;
  });
  const garderId = body.garder === undefined || body.garder === null ? a.id : body.garder;
  if (garderId !== a.id && garderId !== b.id) throw new HttpError(400, 'Champ « garder » : indique l’identifiant de l’un des deux posts.');
  const base = garderId === a.id ? a : b;
  const autre = base === a ? b : a;

  const commun = base.plateformes.filter((n) => autre.plateformes.includes(n));
  if (commun.length) {
    throw new HttpError(400, `Fusion impossible : les deux posts sont déjà prévus sur ${commun.join(' et ')}. Fusionne des posts qui n’ont aucun réseau en commun (par exemple un Instagram et un Facebook).`);
  }

  const choix = body.choix === undefined || body.choix === null ? {} : body.choix;
  if (typeof choix !== 'object' || Array.isArray(choix)) throw new HttpError(400, 'Champ « choix » : un objet est attendu.');
  const permis = [...CHAMPS_FUSION, 'photo'];
  for (const [cle, valeur] of Object.entries(choix)) {
    if (!permis.includes(cle)) throw new HttpError(400, `Champ de fusion inconnu : « ${cle} ». Valeurs possibles : ${permis.join(', ')}.`);
    if (valeur !== a.id && valeur !== b.id && !(cle === 'photo' && valeur === 'aucune')) {
      throw new HttpError(400, `choix.${cle} : indique l’identifiant de l’un des deux posts${cle === 'photo' ? ' (ou « aucune »)' : ''}.`);
    }
  }
  const parId = (id) => (id === a.id ? a : b);

  const fusion = { ...base, plateformes: PLATEFORMES.filter((n) => base.plateformes.includes(n) || autre.plateformes.includes(n)) };
  for (const champ of CHAMPS_FUSION) {
    if (has(choix, champ)) fusion[champ] = parId(choix[champ])[champ];
    else if (estVide(base[champ]) && !estVide(autre[champ])) fusion[champ] = autre[champ];
  }
  if (!has(choix, 'statut') && base.statut !== autre.statut) fusion.statut = 'idee';

  const pb = normaliserPhotos(base.photos);
  const pa = normaliserPhotos(autre.photos);
  const photos = photosVides();
  if (has(choix, 'photo')) photos.meta = choix.photo === 'aucune' ? null : normaliserPhotos(parId(choix.photo).photos).meta;
  else photos.meta = pb.meta || pa.meta;
  photos.linkedin = pb.linkedin || pa.linkedin;
  fusion.photos = photos;

  // Les fichiers photo qui ne servent plus à personne sont supprimés une fois les données enregistrées.
  const gardes = new Set(PHOTO_SLOTS.map((s) => photos[s] && photos[s].fichier).filter(Boolean));
  const aSupprimer = [pb, pa].flatMap((ph) => PHOTO_SLOTS.map((s) => ph[s])).filter((f) => f && !gardes.has(f.fichier));

  const avant = db.posts;
  db.posts = avant.filter((p) => p !== autre).map((p) => (p === base ? fusion : p));
  try {
    saveDb();
  } catch (err) {
    db.posts = avant;
    throw err;
  }
  aSupprimer.forEach(supprimerFichierPhoto);
  return { post: fusion, supprime: autre.id };
}

/* ------------------------------------------------------------------ */
/* Export Excel                                                       */
/* ------------------------------------------------------------------ */

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

const parts = (iso) => iso.split('-').map(Number);
const utc = (iso) => {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d));
};

function jourDe(iso) {
  return JOURS[utc(iso).getUTCDay()];
}

function jourMois(iso) {
  const [, m, d] = parts(iso);
  return `${d === 1 ? '1er' : d} ${MOIS[m - 1]}`;
}

function dateLongue(iso) {
  return `${jourMois(iso)} ${parts(iso)[0]}`;
}

/** « 12 octobre 2026 », « du 12 au 18 octobre 2026 », « du 30 octobre au 3 novembre 2026 » */
function periodeFr(debut, fin) {
  if (!fin || fin === debut) return dateLongue(debut);
  const [y1, m1, d1] = parts(debut);
  const [y2, m2, d2] = parts(fin);
  const j1 = d1 === 1 ? '1er' : d1;
  const j2 = d2 === 1 ? '1er' : d2;
  if (y1 === y2 && m1 === m2) return `du ${j1} au ${j2} ${MOIS[m2 - 1]} ${y2}`;
  if (y1 === y2) return `du ${j1} ${MOIS[m1 - 1]} au ${j2} ${MOIS[m2 - 1]} ${y2}`;
  return `du ${j1} ${MOIS[m1 - 1]} ${y1} au ${j2} ${MOIS[m2 - 1]} ${y2}`;
}

/** « S2 - 5 au 11 oct. » : semaines du lundi au dimanche, tronquées aux bornes du mois. */
function semaineLabel(iso) {
  const [y, m, d] = parts(iso);
  const day = utc(iso);
  const mondayOf = (dt) => {
    const out = new Date(dt);
    out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7));
    return out;
  };
  const monday = mondayOf(day);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const start = monday < first ? first : monday;
  const end = sunday > last ? last : sunday;
  const n = Math.round((monday - mondayOf(first)) / (7 * 86400000)) + 1;
  return `S${n} - ${start.getUTCDate()} au ${end.getUTCDate()} ${MOIS_COURTS[m - 1]}`;
}

function excelDate(iso) {
  return utc(iso); // minuit UTC : ExcelJS l'écrit comme une date sans heure
}

const FONT = { name: 'Calibri', size: 11 };

const STATUT_COULEURS = {
  idee: 'FFFFF1C2',
  valide: 'FFD5EFD7',
  refuse: 'FFF6D3D3',
  publie: 'FFD3E3F6',
};

function styleHeader(row) {
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F2038' } } };
  });
}

/** Estimation (en points) de la hauteur d'une ligne dont le texte passe à la ligne, pour ne rien couper à côté d'une photo. */
function hauteurTexte(row, colonnes) {
  let lignes = 1;
  for (const [cle, largeur] of colonnes) {
    const texte = String(row.getCell(cle).value ?? '');
    const n = texte.split('\n').reduce((tot, para) => tot + Math.max(1, Math.ceil(para.length / largeur)), 0);
    lignes = Math.max(lignes, n);
  }
  return lignes * 15 + 6;
}

async function buildWorkbook(posts, { photos = true } = {}) {
  const evById = new Map(db.evenements.map((e) => [e.id, e]));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Calendy';
  wb.title = 'Calendrier éditorial — ESAT Elisa 30';
  wb.created = new Date();

  /* Feuille 1 : posts */
  // Colonnes photo seulement si au moins un post exporté en a une.
  const photoDe = (p, slot) => (normaliserPhotos(p.photos)[slot] ? p.photos[slot] : null);
  const avecPhotos = photos && posts.some((p) => photoDe(p, 'meta') || photoDe(p, 'linkedin'));
  const ws = wb.addWorksheet('Calendrier éditorial', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] });
  ws.columns = [
    { header: 'Date de publication', key: 'date', width: 16, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Jour', key: 'jour', width: 11 },
    { header: 'Heure', key: 'heure', width: 8 },
    { header: 'Semaine', key: 'semaine', width: 20 },
    { header: 'Réseau(x)', key: 'reseaux', width: 22 },
    { header: 'Atelier / Thème', key: 'atelier', width: 20 },
    { header: 'Titre', key: 'titre', width: 38 },
    { header: 'Description / légende', key: 'description', width: 70 },
    { header: 'Hashtags', key: 'hashtags', width: 34 },
    { header: 'Idée visuelle', key: 'image', width: 40 },
    ...(avecPhotos
      ? [
          { header: 'Photo Instagram + Facebook', key: 'photoMeta', width: 24 },
          { header: 'Photo LinkedIn', key: 'photoLinkedin', width: 24 },
        ]
      : []),
    { header: 'Événement', key: 'evenement', width: 30 },
    { header: "Date de l'événement", key: 'dateEvenement', width: 26 },
    { header: "Explication de l'événement", key: 'explication', width: 52 },
    { header: 'Angle du post', key: 'angle', width: 40 },
    { header: 'Point de vigilance', key: 'vigilance', width: 40 },
    { header: 'Statut', key: 'statut', width: 15 },
  ];
  styleHeader(ws.getRow(1));
  for (const p of posts) {
    const ev = p.eventId ? evById.get(p.eventId) : null;
    const row = ws.addRow({
      date: excelDate(p.datePublication),
      jour: jourDe(p.datePublication),
      heure: p.heure || '',
      semaine: semaineLabel(p.datePublication),
      reseaux: p.plateformes.join(' + '),
      atelier: p.atelier,
      titre: p.titre,
      description: p.description,
      hashtags: p.hashtags,
      image: p.imageIdee,
      evenement: ev ? ev.nom : '—',
      dateEvenement: ev ? periodeFr(ev.dateDebut, ev.dateFin) : '',
      explication: ev ? ev.explication : '',
      angle: p.angle,
      vigilance: p.vigilance,
      statut: STATUT_LIBELLES[p.statut],
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('date').alignment = { vertical: 'top', horizontal: 'left' };
    row.getCell('titre').font = { ...FONT, bold: true };
    row.getCell('statut').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUT_COULEURS[p.statut] } };
    row.getCell('statut').font = { ...FONT, bold: true };

    if (avecPhotos) {
      const COLONNES_TEXTE = [['titre', 38], ['description', 70], ['hashtags', 34], ['image', 40], ['evenement', 30], ['explication', 52], ['angle', 40], ['vigilance', 40]];
      let hauteurPhoto = 0;
      for (const [slot, cle] of [['meta', 'photoMeta'], ['linkedin', 'photoLinkedin']]) {
        const ph = photoDe(p, slot);
        if (!ph) continue;
        let buffer;
        try {
          buffer = fs.readFileSync(cheminPhoto(ph.fichier));
        } catch {
          continue; // fichier manquant : on exporte le post sans la photo
        }
        const echelle = Math.min(150 / ph.largeur, 150 / ph.hauteur, 1);
        const largeur = Math.round(ph.largeur * echelle);
        const hauteur = Math.round(ph.hauteur * echelle);
        const imageId = wb.addImage({ buffer, extension: ph.type === 'image/png' ? 'png' : 'jpeg' });
        ws.addImage(imageId, {
          tl: { col: ws.getColumn(cle).number - 1 + 0.04, row: row.number - 1 + 0.03 },
          ext: { width: largeur, height: hauteur },
          editAs: 'oneCell',
        });
        hauteurPhoto = Math.max(hauteurPhoto, hauteur * 0.75 + 8);
      }
      // Hauteurs fixes pour toutes les lignes : les photos restent ainsi ancrées à la bonne ligne dans Excel comme dans LibreOffice.
      row.height = Math.max(hauteurPhoto, hauteurTexte(row, COLONNES_TEXTE), 24);
    }
  }
  if (posts.length) ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  /* Feuille 2 : événements concernés par ces posts */
  const used = [...new Set(posts.map((p) => p.eventId).filter(Boolean))]
    .map((id) => evById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut) || a.nom.localeCompare(b.nom));
  const we = wb.addWorksheet('Événements', { views: [{ state: 'frozen', ySplit: 1 }] });
  we.columns = [
    { header: 'Date(s)', key: 'dates', width: 30 },
    { header: 'Événement', key: 'nom', width: 38 },
    { header: "Ce qu'il faut savoir", key: 'explication', width: 70 },
    { header: 'Lien avec Elisa30', key: 'lien', width: 60 },
    { header: 'Posts prévus', key: 'nb', width: 13 },
  ];
  styleHeader(we.getRow(1));
  for (const ev of used) {
    const row = we.addRow({
      dates: periodeFr(ev.dateDebut, ev.dateFin),
      nom: ev.nom,
      explication: ev.explication,
      lien: ev.lienElisa30,
      nb: posts.filter((p) => p.eventId === ev.id).length,
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('nom').font = { ...FONT, bold: true };
    row.getCell('nb').alignment = { vertical: 'top', horizontal: 'center' };
  }
  we.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  return wb.xlsx.writeBuffer();
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/health$/, () => ({ ok: true }));

route('GET', /^\/api\/state$/, () => ({
  evenements: [...db.evenements].sort((a, b) => a.dateDebut.localeCompare(b.dateDebut) || a.nom.localeCompare(b.nom)),
  posts: [...db.posts].sort(byDate),
  statuts: STATUT_LIBELLES,
  plateformes: PLATEFORMES,
}));

/* Événements */
route('GET', /^\/api\/evenements$/, ({ query }) => {
  let list = db.evenements;
  if (query.du) list = list.filter((e) => e.dateFin >= date(query.du, 'du'));
  if (query.au) list = list.filter((e) => e.dateDebut <= date(query.au, 'au'));
  return [...list].sort((a, b) => a.dateDebut.localeCompare(b.dateDebut) || a.nom.localeCompare(b.nom));
});

route('POST', /^\/api\/evenements$/, ({ body }) => {
  const ev = { id: newId('ev'), ...cleanEvent(body) };
  db.evenements.push(ev);
  saveDb();
  return { status: 201, body: ev };
});

route('GET', /^\/api\/evenements\/([\w-]+)$/, ({ params }) => {
  const ev = db.evenements.find((e) => e.id === params[0]);
  if (!ev) throw new HttpError(404, 'Événement introuvable.');
  return { ...ev, posts: db.posts.filter((p) => p.eventId === ev.id).sort(byDate) };
});

route('PUT', /^\/api\/evenements\/([\w-]+)$/, ({ params, body }) => {
  const i = db.evenements.findIndex((e) => e.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Événement introuvable.');
  db.evenements[i] = cleanEvent(body, db.evenements[i]);
  saveDb();
  return db.evenements[i];
});

route('DELETE', /^\/api\/evenements\/([\w-]+)$/, ({ params }) => {
  const i = db.evenements.findIndex((e) => e.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Événement introuvable.');
  const [removed] = db.evenements.splice(i, 1);
  let detaches = 0;
  for (const p of db.posts) {
    if (p.eventId === removed.id) {
      p.eventId = null;
      detaches += 1;
    }
  }
  saveDb();
  return { ok: true, supprime: removed.id, postsDetaches: detaches };
});

/* Posts */
route('GET', /^\/api\/posts$/, ({ query }) => filterPosts(query));

route('POST', /^\/api\/posts$/, ({ body }) => {
  const post = { id: newId('po'), ...cleanPost(body) };
  db.posts.push(post);
  saveDb();
  return { status: 201, body: post };
});

// Changement de statut en lot : { ids: [...], statut: 'valide' } — déclaré avant /:id
route('POST', /^\/api\/posts\/statut$/, ({ body }) => {
  if (!body || !Array.isArray(body.ids) || !body.ids.length) throw new HttpError(400, 'Champ « ids » (liste) attendu.');
  const nouveau = statut(body.statut);
  const trouves = db.posts.filter((p) => body.ids.includes(p.id));
  const inconnus = body.ids.filter((id) => !trouves.some((p) => p.id === id));
  if (inconnus.length) throw new HttpError(404, `Posts introuvables : ${inconnus.join(', ')}`);
  trouves.forEach((p) => {
    p.statut = nouveau;
  });
  saveDb();
  return { ok: true, modifies: trouves.length, statut: nouveau };
});

// Fusion de deux posts (ex. un Instagram + un Facebook) : { ids: [a, b], garder?, choix? } — voir fusionnerPosts
route('POST', /^\/api\/posts\/fusionner$/, ({ body }) => fusionnerPosts(body));

// Copies d'un post sur d'autres dates : { dates: ['2026-11-03', ...] }
route('POST', /^\/api\/posts\/([\w-]+)\/cloner$/, ({ params, body }) => clonerPost(params[0], body));

route('GET', /^\/api\/posts\/([\w-]+)$/, ({ params }) => {
  const post = db.posts.find((p) => p.id === params[0]);
  if (!post) throw new HttpError(404, 'Post introuvable.');
  const ev = post.eventId ? db.evenements.find((e) => e.id === post.eventId) : null;
  return { ...post, evenement: ev || null };
});

route('PUT', /^\/api\/posts\/([\w-]+)$/, ({ params, body }) => {
  const i = db.posts.findIndex((p) => p.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Post introuvable.');
  db.posts[i] = cleanPost(body, db.posts[i]);
  saveDb();
  return db.posts[i];
});

route('DELETE', /^\/api\/posts\/([\w-]+)$/, ({ params }) => {
  const i = db.posts.findIndex((p) => p.id === params[0]);
  if (i < 0) throw new HttpError(404, 'Post introuvable.');
  const [removed] = db.posts.splice(i, 1);
  saveDb();
  PHOTO_SLOTS.forEach((slot) => supprimerFichierPhoto(removed.photos && removed.photos[slot]));
  return { ok: true, supprime: removed.id };
});

// Photo d'un post : slot « meta » (Instagram + Facebook) ou « linkedin ». L'envoi (PUT, corps = image brute) est traité dans handle().
route('GET', /^\/api\/posts\/([\w-]+)\/photo\/(meta|linkedin)$/, ({ params }) => {
  const post = db.posts.find((p) => p.id === params[0]);
  if (!post) throw new HttpError(404, 'Post introuvable.');
  const photo = normaliserPhotos(post.photos)[params[1]];
  if (!photo) throw new HttpError(404, 'Pas de photo pour ce visuel.');
  let raw;
  try {
    raw = fs.readFileSync(cheminPhoto(photo.fichier));
  } catch {
    throw new HttpError(404, 'Fichier photo introuvable sur le serveur.');
  }
  return { raw, type: photo.type, inline: true, cache: 'private, max-age=3600' };
});

route('DELETE', /^\/api\/posts\/([\w-]+)\/photo\/(meta|linkedin)$/, ({ params }) => {
  const post = db.posts.find((p) => p.id === params[0]);
  if (!post) throw new HttpError(404, 'Post introuvable.');
  post.photos = normaliserPhotos(post.photos);
  const ancienne = post.photos[params[1]];
  post.photos[params[1]] = null;
  saveDb();
  supprimerFichierPhoto(ancienne);
  return post;
});

/* Export Excel : ?statuts=valide,publie (défaut) | all  &du=AAAA-MM-JJ &au=AAAA-MM-JJ  &photos=0 (sans les photos) */
route('GET', /^\/api\/export\.xlsx$/, async ({ query }) => {
  const statuts = !query.statuts ? ['valide', 'publie'] : query.statuts === 'all' ? STATUTS : query.statuts.split(',');
  const posts = filterPosts({ statut: statuts.join(','), du: query.du, au: query.au });
  const buffer = await buildWorkbook(posts, { photos: query.photos !== '0' });
  const stamp = new Date().toISOString().slice(0, 10);
  const periode = query.du || query.au ? `_${query.du || 'debut'}_${query.au || 'fin'}` : '';
  return {
    raw: Buffer.from(buffer),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `Calendrier_editorial_Elisa30${periode}_${stamp}.xlsx`,
    headers: { 'X-Calendy-Posts': String(posts.length) },
  };
});

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

function jetonRecu(req) {
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-calendy-token'] || '';
  return nettoyerJeton(given);
}

function tokenOk(req) {
  if (!TOKEN) return true;
  const a = crypto.createHash('sha256').update(jetonRecu(req)).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  const ok = crypto.timingSafeEqual(a, b);
  // Aide au diagnostic : on journalise la longueur (jamais la valeur) d'un jeton refusé.
  if (!ok) {
    const recu = jetonRecu(req);
    if (recu) console.warn(`Jeton refusé : ${recu.length} caractères reçus, ${TOKEN.length} attendus.`);
  }
  return ok;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Requête trop volumineuse.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(url.searchParams);

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(INDEX_FILE);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src data:; connect-src 'self'; frame-ancestors 'none'",
    });
    return res.end(html);
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (!pathname.startsWith('/api/')) return send(res, 404, { error: 'Introuvable.' }, SECURITY_HEADERS);

  // Anti-CSRF : un navigateur qui appelle l'API depuis un autre site envoie un en-tête Origin différent de l'hôte.
  // Le pont MCP et curl n'envoient pas d'Origin ; l'interface, elle, appelle son propre hôte.
  if (req.headers.origin) {
    let origineHote = '';
    try { origineHote = new URL(req.headers.origin).host; } catch { /* origine illisible : refusée plus bas */ }
    if (origineHote !== req.headers.host) return send(res, 403, { error: 'Origine non autorisée.' }, SECURITY_HEADERS);
  }

  if (pathname !== '/api/health' && !tokenOk(req)) {
    return send(res, 401, { error: 'Jeton d’accès manquant ou invalide.' }, SECURITY_HEADERS);
  }

  // Envoi d'une photo : le corps est l'image elle-même (pas du JSON).
  const mPhoto = req.method === 'PUT' && pathname.match(/^\/api\/posts\/([\w-]+)\/photo\/(meta|linkedin)$/);
  if (mPhoto) return send(res, 200, await enregistrerPhoto(req, mPhoto[1], mPhoto[2]), SECURITY_HEADERS);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.pattern);
    if (!match) continue;
    const hasBody = req.method === 'POST' || req.method === 'PUT';
    if (hasBody && !/^application\/json/i.test(req.headers['content-type'] || '')) {
      throw new HttpError(415, 'Content-Type application/json requis.');
    }
    const body = hasBody ? await readBody(req) : undefined;
    const result = await r.handler({ params: match.slice(1), query, body });
    if (result && result.raw && result.inline) {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': result.type,
        'Content-Length': result.raw.length,
        'Cache-Control': result.cache || 'no-store',
      });
      return res.end(result.raw);
    }
    if (result && result.raw) {
      const name = encodeURIComponent(result.filename);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        ...result.headers,
        'Content-Type': result.type,
        'Content-Length': result.raw.length,
        'Content-Disposition': `attachment; filename="${result.filename.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${name}`,
        'Access-Control-Expose-Headers': 'Content-Disposition, X-Calendy-Posts',
        'Cache-Control': 'no-store',
      });
      return res.end(result.raw);
    }
    if (result && result.status && result.body !== undefined) return send(res, result.status, result.body, SECURITY_HEADERS);
    return send(res, 200, result, SECURITY_HEADERS);
  }
  return send(res, 404, { error: 'Route inconnue.' }, SECURITY_HEADERS);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message }, SECURITY_HEADERS);
    console.error(err);
    return send(res, 500, { error: 'Erreur interne du serveur.' }, SECURITY_HEADERS);
  });
});

if (require.main === module) {
  loadDb();
  server.listen(PORT, HOST, () => {
    console.log(`Calendy prêt sur http://${HOST}:${PORT}  (données : ${DATA_FILE})`);
    if (!TOKEN) {
      console.log('Aucun CALENDY_TOKEN défini : l’API est ouverte à quiconque atteint ce port.');
    } else {
      const retouche = TOKEN !== TOKEN_BRUT ? ' (espaces ou guillemets en trop retirés)' : '';
      console.log(`Jeton d'accès actif : ${TOKEN.length} caractères${retouche}.`);
    }
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { semaineLabel, periodeFr, nettoyerJeton };
