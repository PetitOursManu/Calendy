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
const TOKEN = process.env.CALENDY_TOKEN || '';
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
/* Stockage                                                           */
/* ------------------------------------------------------------------ */

let db = { evenements: [], posts: [] };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = {
      evenements: Array.isArray(parsed.evenements) ? parsed.evenements : [],
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
    };
    return;
  }
  const seedFile = path.join(__dirname, 'seed.json');
  if (!process.env.CALENDY_NO_SEED && fs.existsSync(seedFile)) {
    db = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
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

async function buildWorkbook(posts) {
  const evById = new Map(db.evenements.map((e) => [e.id, e]));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Calendy';
  wb.title = 'Calendrier éditorial — ESAT Elisa 30';
  wb.created = new Date();

  /* Feuille 1 : posts */
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
  return { ok: true, supprime: removed.id };
});

/* Export Excel : ?statuts=valide,publie (défaut) | all  &du=AAAA-MM-JJ &au=AAAA-MM-JJ */
route('GET', /^\/api\/export\.xlsx$/, async ({ query }) => {
  const statuts = !query.statuts ? ['valide', 'publie'] : query.statuts === 'all' ? STATUTS : query.statuts.split(',');
  const posts = filterPosts({ statut: statuts.join(','), du: query.du, au: query.au });
  const buffer = await buildWorkbook(posts);
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

function tokenOk(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-calendy-token'] || '';
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
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
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src data:; connect-src 'self'; frame-ancestors 'none'",
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
    if (!TOKEN) console.log('Aucun CALENDY_TOKEN défini : l’API est ouverte à quiconque atteint ce port.');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { semaineLabel, periodeFr };
