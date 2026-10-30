'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { semaineLabel, periodeFr, nettoyerJeton } = require('../server.js');

const TOKEN = 'jeton-de-test-0123456789';
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dataDir;

async function api(method, url, body, { token = TOKEN, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  if (raw) return res;
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-test-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CALENDY_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
    child.on('exit', (code) => reject(new Error(`serveur arrêté (code ${code})`)));
    setTimeout(() => reject(new Error('démarrage trop long')), 8000);
  });
});

after(() => {
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('semaineLabel reproduit les libellés du fichier Excel d’origine', () => {
  assert.equal(semaineLabel('2026-10-01'), 'S1 - 1 au 4 oct.');
  assert.equal(semaineLabel('2026-10-06'), 'S2 - 5 au 11 oct.');
  assert.equal(semaineLabel('2026-10-12'), 'S3 - 12 au 18 oct.');
  assert.equal(semaineLabel('2026-10-23'), 'S4 - 19 au 25 oct.');
  assert.equal(semaineLabel('2026-10-31'), 'S5 - 26 au 31 oct.');
});

test('periodeFr formate les dates et périodes', () => {
  assert.equal(periodeFr('2026-10-06', '2026-10-06'), '6 octobre 2026');
  assert.equal(periodeFr('2026-10-12', '2026-10-18'), 'du 12 au 18 octobre 2026');
  assert.equal(periodeFr('2026-10-30', '2026-11-03'), 'du 30 octobre au 3 novembre 2026');
  assert.equal(periodeFr('2026-11-01', '2026-11-01'), '1er novembre 2026');
});

test('santé et authentification', async () => {
  assert.equal((await api('GET', '/api/health', undefined, { token: '' })).status, 200);
  assert.equal((await api('GET', '/api/state', undefined, { token: '' })).status, 401);
  assert.equal((await api('GET', '/api/state', undefined, { token: 'mauvais' })).status, 401);
  assert.equal((await api('GET', '/api/state')).status, 200);
});

test('nettoyerJeton retire espaces, retours à la ligne et guillemets d’enveloppe', () => {
  assert.equal(nettoyerJeton('abc123'), 'abc123');
  assert.equal(nettoyerJeton('abc123\n'), 'abc123');
  assert.equal(nettoyerJeton('  abc123 \r\n'), 'abc123');
  assert.equal(nettoyerJeton('"abc123"'), 'abc123');
  assert.equal(nettoyerJeton("'abc123'\n"), 'abc123');
  assert.equal(nettoyerJeton('"abc 123"'), 'abc 123');
  assert.equal(nettoyerJeton('ab"c1"23'), 'ab"c1"23', 'guillemets au milieu : on ne touche à rien');
  assert.equal(nettoyerJeton('"abc123'), '"abc123', 'guillemet isolé : on ne touche à rien');
  assert.equal(nettoyerJeton(undefined), '');
});

test('un jeton mal formé dans la variable d’environnement reste utilisable', async () => {
  const cas = [
    ['retour à la ligne final', 'secret-de-test\n', 'secret-de-test'],
    ['espaces autour', '  secret-de-test  ', 'secret-de-test'],
    ['guillemets autour', '"secret-de-test"', 'secret-de-test'],
    ['guillemets collés avec le jeton', 'secret-de-test', '"secret-de-test"'],
  ];
  for (const [nom, valeurEnv, envoye] of cas) {
    const port = 4100 + Math.floor(Math.random() * 400);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-jeton-'));
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, CALENDY_TOKEN: valeurEnv, CALENDY_NO_SEED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    try {
      await new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
        proc.on('exit', (code) => reject(new Error(`serveur arrêté (code ${code})`)));
        setTimeout(() => reject(new Error('démarrage trop long')), 8000);
      });
      const url = `http://127.0.0.1:${port}/api/state`;
      const bon = await fetch(url, { headers: { Authorization: `Bearer ${envoye}` } });
      assert.equal(bon.status, 200, `jeton accepté : ${nom}`);
      const faux = await fetch(url, { headers: { Authorization: 'Bearer autre-chose' } });
      assert.equal(faux.status, 401, `mauvais jeton toujours refusé : ${nom}`);
      const aucun = await fetch(url);
      assert.equal(aucun.status, 401, `sans jeton toujours refusé : ${nom}`);
    } finally {
      proc.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Petites images réelles (JPEG 40×30 et PNG 40×30) pour les tests de photos.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnKKKK6T2wooooAKKKKACiiigAooooAKKKKAP/2Q==', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAO0lEQVR4Xu3QUQ0AMAyE0K5Kam12pnqpCe6HZ4CE8+ZWQieiyzDG1RhXY1yNcTXG1RhXY1yNcTUmtvoDgI8BR1lq6aUAAAAASUVORK5CYII=', 'base64');

async function envoyerPhoto(id, slot, corps, type) {
  const res = await fetch(`${BASE}/api/posts/${id}/photo/${slot}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': type },
    body: corps,
  });
  return { status: res.status, json: await res.json() };
}

test('photos : facultatives, une par visuel (Instagram+Facebook / LinkedIn), remplaçables et supprimables', async () => {
  const { json: post } = await api('POST', '/api/posts', {
    titre: 'Test photo', datePublication: '2026-11-05', plateformes: ['Instagram', 'Facebook', 'LinkedIn'],
  });
  assert.deepEqual(post.photos, { meta: null, linkedin: null }, 'sans photo par défaut');
  assert.equal((await api('GET', `/api/posts/${post.id}/photo/meta`)).status, 404);

  const m = await envoyerPhoto(post.id, 'meta', JPEG, 'image/jpeg');
  assert.equal(m.status, 200);
  assert.equal(m.json.photos.meta.largeur, 40);
  assert.equal(m.json.photos.meta.hauteur, 30);
  assert.equal(m.json.photos.linkedin, null);
  const l = await envoyerPhoto(post.id, 'linkedin', PNG, 'image/png');
  assert.equal(l.json.photos.linkedin.type, 'image/png');
  assert.notEqual(l.json.photos.linkedin.fichier, l.json.photos.meta.fichier, 'deux visuels distincts');

  const lue = await api('GET', `/api/posts/${post.id}/photo/meta`, undefined, { raw: true });
  assert.equal(lue.status, 200);
  assert.equal(lue.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await lue.arrayBuffer()), JPEG);

  // Remplacer : l'ancien fichier disparaît du disque
  const ancien = m.json.photos.meta.fichier;
  const r = await envoyerPhoto(post.id, 'meta', PNG, 'image/png');
  assert.notEqual(r.json.photos.meta.fichier, ancien);
  assert.ok(!fs.existsSync(path.join(dataDir, 'images', ancien)), 'ancien fichier supprimé');

  // Modifier le post ne touche pas aux photos, et le JSON ne peut pas les forger
  const maj = await api('PUT', `/api/posts/${post.id}`, { titre: 'Test photo 2', photos: { meta: { fichier: '../../etc/passwd' } } });
  assert.equal(maj.json.photos.meta.fichier, r.json.photos.meta.fichier);

  // Suppression d'une photo, puis du post (le fichier restant est effacé)
  const del = await api('DELETE', `/api/posts/${post.id}/photo/meta`);
  assert.equal(del.json.photos.meta, null);
  assert.ok(del.json.photos.linkedin, 'la photo LinkedIn reste');
  const fichierLinkedin = l.json.photos.linkedin.fichier;
  assert.ok(fs.existsSync(path.join(dataDir, 'images', fichierLinkedin)));
  await api('DELETE', `/api/posts/${post.id}`);
  assert.ok(!fs.existsSync(path.join(dataDir, 'images', fichierLinkedin)), 'fichier effacé avec le post');
});

test('photos : refus des fichiers qui ne sont pas des images JPEG/PNG', async () => {
  const { json: post } = await api('POST', '/api/posts', { titre: 'Test refus', datePublication: '2026-11-06', plateformes: ['Instagram'] });
  try {
  assert.equal((await envoyerPhoto(post.id, 'meta', Buffer.from('<?php echo 1; ?>'), 'image/jpeg')).status, 400, 'faux JPEG');
  assert.equal((await envoyerPhoto(post.id, 'meta', JPEG, 'image/png')).status, 400, 'type annoncé ≠ contenu');
  assert.equal((await envoyerPhoto(post.id, 'meta', Buffer.from('GIF89a'), 'image/gif')).status, 415, 'GIF non accepté');
  assert.equal((await envoyerPhoto(post.id, 'meta', Buffer.alloc(9 * 1024 * 1024, 1), 'image/jpeg')).status, 413, 'trop lourd');
  assert.equal((await envoyerPhoto('po-inconnu', 'meta', JPEG, 'image/jpeg')).status, 404);
  const sans = await fetch(`${BASE}/api/posts/${post.id}/photo/meta`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
  assert.equal(sans.status, 401, 'jeton exigé');
  assert.deepEqual((await api('GET', `/api/posts/${post.id}`)).json.photos, { meta: null, linkedin: null });
  } finally {
    await api('DELETE', `/api/posts/${post.id}`);
  }
});

test('export Excel : les photos sont intégrées (colonnes seulement si besoin) et peuvent être exclues', async () => {
  const { json: post } = await api('POST', '/api/posts', {
    titre: 'Export photo', datePublication: '2026-11-07', plateformes: ['Instagram', 'LinkedIn'], statut: 'valide',
  });
  const lire = async (url) => {
    const res = await api('GET', url, undefined, { raw: true });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    return wb;
  };
  const sans = await lire('/api/export.xlsx?statuts=valide&du=2026-11-07&au=2026-11-07');
  assert.ok(!sans.getWorksheet('Calendrier éditorial').getRow(1).values.includes('Photo LinkedIn'), 'pas de colonne sans photo');

  await envoyerPhoto(post.id, 'meta', JPEG, 'image/jpeg');
  await envoyerPhoto(post.id, 'linkedin', PNG, 'image/png');
  const avec = await lire('/api/export.xlsx?statuts=valide&du=2026-11-07&au=2026-11-07');
  const ws = avec.getWorksheet('Calendrier éditorial');
  assert.ok(ws.getRow(1).values.includes('Photo Instagram + Facebook'));
  assert.ok(ws.getRow(1).values.includes('Photo LinkedIn'));
  assert.equal(ws.getImages().length, 2, 'deux images intégrées');
  assert.ok(ws.getRow(2).height > 20, 'ligne assez haute pour la photo');

  const exclues = await lire('/api/export.xlsx?statuts=valide&du=2026-11-07&au=2026-11-07&photos=0');
  assert.equal(exclues.getWorksheet('Calendrier éditorial').getImages().length, 0);
  await api('DELETE', `/api/posts/${post.id}`);
});

test('premier démarrage : seed chargé (18 posts, 8 événements)', async () => {
  const { json } = await api('GET', '/api/state');
  assert.equal(json.posts.length, 18);
  assert.equal(json.evenements.length, 8);
  assert.deepEqual(json.plateformes, ['Instagram', 'Facebook', 'LinkedIn']);
  assert.ok(fs.existsSync(path.join(dataDir, 'data.json')));
});

test('la page HTML est servie sans jeton, avec une politique de sécurité', async () => {
  const res = await api('GET', '/', undefined, { token: '', raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /font-src data:/); // les polices sont embarquées dans la page
  assert.match(csp, /connect-src 'self'/);
  assert.ok((await res.text()).includes('<title>Calendy</title>'));
});

test('anti-CSRF : origine étrangère et Content-Type incorrect refusés', async () => {
  const entetes = { Authorization: `Bearer ${TOKEN}` };
  const corps = JSON.stringify({ titre: 'x', datePublication: '2026-11-01', plateformes: ['Instagram'] });
  const etrangere = await fetch(`${BASE}/api/posts`, {
    method: 'POST',
    headers: { ...entetes, 'Content-Type': 'application/json', Origin: 'https://site-malveillant.example' },
    body: corps,
  });
  assert.equal(etrangere.status, 403);
  const memeOrigine = await fetch(`${BASE}/api/state`, { headers: { ...entetes, Origin: BASE } });
  assert.equal(memeOrigine.status, 200);
  const simple = await fetch(`${BASE}/api/posts`, { method: 'POST', headers: { ...entetes, 'Content-Type': 'text/plain' }, body: corps });
  assert.equal(simple.status, 415);
  const sansType = await fetch(`${BASE}/api/posts`, { method: 'POST', headers: entetes, body: corps });
  assert.equal(sansType.status, 415);
  const count = (await api('GET', '/api/posts')).json.length;
  assert.equal(count, 18, 'aucun de ces appels n’a créé de post');
});

test('validation des posts', async () => {
  const ok = { titre: 'Test', datePublication: '2026-11-05', plateformes: ['Instagram'] };
  assert.equal((await api('POST', '/api/posts', { ...ok, titre: '' })).status, 400);
  assert.equal((await api('POST', '/api/posts', { ...ok, datePublication: '2026-02-30' })).status, 400);
  assert.equal((await api('POST', '/api/posts', { ...ok, datePublication: '05/11/2026' })).status, 400);
  assert.equal((await api('POST', '/api/posts', { ...ok, plateformes: ['TikTok'] })).status, 400);
  assert.equal((await api('POST', '/api/posts', { ...ok, plateformes: [] })).status, 400);
  assert.equal((await api('POST', '/api/posts', { ...ok, heure: '25:00' })).status, 400);
  assert.equal((await api('POST', '/api/posts', { ...ok, statut: 'brouillon' })).status, 400);
  assert.equal((await api('POST', '/api/posts', { ...ok, eventId: 'ev-inconnu' })).status, 400);
  assert.equal((await api('POST', '/api/posts', '{pas du json')).status, 400);
});

test('cycle de vie d’un post : création, modification, statut, suppression', async () => {
  const created = await api('POST', '/api/posts', {
    titre: '  Téléthon : on se mobilise ',
    datePublication: '2026-12-04',
    plateformes: 'linkedin + instagram',
    hashtags: 'ESAT, #Handicap  Téléthon',
    eventId: 'ev-duoday',
  });
  assert.equal(created.status, 201);
  const post = created.json;
  assert.equal(post.titre, 'Téléthon : on se mobilise');
  assert.deepEqual(post.plateformes, ['Instagram', 'LinkedIn']); // ordre canonique
  assert.equal(post.hashtags, '#ESAT #Handicap #Téléthon');
  assert.equal(post.statut, 'idee');

  const updated = await api('PUT', `/api/posts/${post.id}`, { description: 'Texte', statut: 'valide' });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.description, 'Texte');
  assert.equal(updated.json.titre, 'Téléthon : on se mobilise'); // champs absents conservés
  assert.equal(updated.json.statut, 'valide');

  const detail = await api('GET', `/api/posts/${post.id}`);
  assert.equal(detail.json.evenement.id, 'ev-duoday');

  const bulk = await api('POST', '/api/posts/statut', { ids: [post.id, 'po-20261001'], statut: 'valide' });
  assert.equal(bulk.json.modifies, 2);
  assert.equal((await api('POST', '/api/posts/statut', { ids: ['po-nope'], statut: 'valide' })).status, 404);

  assert.equal((await api('DELETE', `/api/posts/${post.id}`)).status, 200);
  assert.equal((await api('GET', `/api/posts/${post.id}`)).status, 404);
});

const fichiersImages = () => fs.readdirSync(path.join(dataDir, 'images'));

test('déplacer un post : la date change, le reste est conservé', async () => {
  const { json: post } = await api('POST', '/api/posts', {
    titre: 'À déplacer', datePublication: '2026-11-10', heure: '11:30', plateformes: ['Instagram', 'Facebook'], statut: 'valide',
  });
  const moved = await api('PUT', `/api/posts/${post.id}`, { datePublication: '2026-11-12' });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.datePublication, '2026-11-12');
  assert.equal(moved.json.heure, '11:30');
  assert.equal(moved.json.statut, 'valide', 'déplacer ne change pas le statut');
  assert.equal((await api('PUT', `/api/posts/${post.id}`, { datePublication: '2026-02-30' })).status, 400);
  await api('DELETE', `/api/posts/${post.id}`);
});

test('cloner un post : une copie « idée à valider » par date, avec ses propres photos', async () => {
  const { json: post } = await api('POST', '/api/posts', {
    titre: 'Original', description: 'Légende', hashtags: '#ESAT', datePublication: '2026-11-10', heure: '09:00',
    plateformes: ['Instagram', 'Facebook'], eventId: 'ev-duoday', statut: 'publie',
  });
  await envoyerPhoto(post.id, 'meta', JPEG, 'image/jpeg');
  const avant = fichiersImages().length;

  const res = await api('POST', `/api/posts/${post.id}/cloner`, { dates: ['2026-11-24', '2026-11-17', '2026-11-17'] });
  assert.equal(res.status, 201);
  assert.equal(res.json.clones.length, 2, 'doublons de dates ignorés');
  assert.deepEqual(res.json.clones.map((c) => c.datePublication), ['2026-11-17', '2026-11-24'], 'triées par date');
  for (const c of res.json.clones) {
    assert.notEqual(c.id, post.id);
    assert.equal(c.statut, 'idee', 'une copie repart « à valider »');
    assert.equal(c.titre, 'Original');
    assert.equal(c.description, 'Légende');
    assert.equal(c.heure, '09:00');
    assert.equal(c.eventId, 'ev-duoday');
    assert.deepEqual(c.plateformes, ['Instagram', 'Facebook']);
    assert.ok(c.photos.meta && c.photos.meta.fichier !== (await api('GET', `/api/posts/${post.id}`)).json.photos.meta.fichier, 'fichier photo propre');
    const lue = await api('GET', `/api/posts/${c.id}/photo/meta`, undefined, { raw: true });
    assert.deepEqual(Buffer.from(await lue.arrayBuffer()), JPEG, 'photo copiée à l’identique');
  }
  assert.equal(fichiersImages().length, avant + 2);
  assert.equal((await api('GET', `/api/posts/${post.id}`)).json.statut, 'publie', 'l’original ne bouge pas');

  // Les copies sont indépendantes de l'original : supprimer l'une n'efface pas les photos des autres
  await api('DELETE', `/api/posts/${res.json.clones[0].id}`);
  assert.equal((await api('GET', `/api/posts/${post.id}/photo/meta`, undefined, { raw: true })).status, 200);
  assert.equal((await api('GET', `/api/posts/${res.json.clones[1].id}/photo/meta`, undefined, { raw: true })).status, 200);

  // Cloner sur le même jour est permis ; les entrées invalides sont refusées
  assert.equal((await api('POST', `/api/posts/${post.id}/cloner`, { dates: ['2026-11-10'] })).status, 201);
  assert.equal((await api('POST', `/api/posts/${post.id}/cloner`, {})).status, 400);
  assert.equal((await api('POST', `/api/posts/${post.id}/cloner`, { dates: [] })).status, 400);
  assert.equal((await api('POST', `/api/posts/${post.id}/cloner`, { dates: ['2026-13-01'] })).status, 400);
  assert.equal((await api('POST', `/api/posts/${post.id}/cloner`, { dates: ['demain'] })).status, 400);
  assert.equal((await api('POST', '/api/posts/po-inconnu/cloner', { dates: ['2026-11-10'] })).status, 404);

  const tous = (await api('GET', '/api/posts?q=Original')).json;
  for (const p of tous) await api('DELETE', `/api/posts/${p.id}`);
  assert.equal(fichiersImages().length, avant - 1, 'plus aucune photo de ces posts sur le disque');
});

test('fusionner un post Instagram et un post Facebook en un seul', async () => {
  const ig = (await api('POST', '/api/posts', {
    titre: 'Semaine du goût', description: 'Légende Instagram', hashtags: '#goût', datePublication: '2026-11-10', heure: '11:00',
    plateformes: ['Instagram'], statut: 'valide', atelier: 'Cuisine',
  })).json;
  const fb = (await api('POST', '/api/posts', {
    titre: 'Semaine du goût (Facebook)', description: 'Légende Facebook plus longue', datePublication: '2026-11-10',
    plateformes: ['Facebook'], statut: 'valide', angle: 'Angle FB', eventId: 'ev-duoday',
  })).json;
  await envoyerPhoto(ig.id, 'meta', JPEG, 'image/jpeg');
  const photoFb = (await envoyerPhoto(fb.id, 'meta', PNG, 'image/png')).json.photos.meta.fichier;
  const photoIg = (await api('GET', `/api/posts/${ig.id}`)).json.photos.meta.fichier;

  // Choix explicites : texte et photo de Facebook, titre de l'Instagram
  const res = await api('POST', '/api/posts/fusionner', { ids: [ig.id, fb.id], choix: { description: fb.id, photo: fb.id } });
  assert.equal(res.status, 200);
  const p = res.json.post;
  assert.equal(res.json.supprime, fb.id);
  assert.equal(p.id, ig.id, 'le premier post garde son identifiant');
  assert.deepEqual(p.plateformes, ['Instagram', 'Facebook']);
  assert.equal(p.titre, 'Semaine du goût', 'sans choix : le post gardé');
  assert.equal(p.description, 'Légende Facebook plus longue', 'choix : Facebook');
  assert.equal(p.hashtags, '#goût');
  assert.equal(p.heure, '11:00');
  assert.equal(p.atelier, 'Cuisine');
  assert.equal(p.angle, 'Angle FB', 'champ vide du post gardé : repris de l’autre');
  assert.equal(p.eventId, 'ev-duoday', 'idem pour l’événement');
  assert.equal(p.statut, 'valide', 'statuts identiques : conservé');
  assert.equal(p.photos.meta.fichier, photoFb, 'photo choisie');
  assert.equal((await api('GET', `/api/posts/${fb.id}`)).status, 404, 'l’autre post est supprimé');
  assert.ok(!fichiersImages().includes(photoIg), 'photo non retenue effacée');
  assert.ok(fichiersImages().includes(photoFb), 'photo retenue conservée');
  const lue = await api('GET', `/api/posts/${ig.id}/photo/meta`, undefined, { raw: true });
  assert.deepEqual(Buffer.from(await lue.arrayBuffer()), PNG);
  await api('DELETE', `/api/posts/${ig.id}`);
  assert.ok(!fichiersImages().includes(photoFb));
});

test('fusionner : valeurs par défaut, statuts différents, photo « aucune » et garder', async () => {
  const a = (await api('POST', '/api/posts', { titre: 'A', datePublication: '2026-11-11', plateformes: ['Instagram'], statut: 'valide' })).json;
  const b = (await api('POST', '/api/posts', { titre: 'B', description: 'Texte B', datePublication: '2026-11-12', plateformes: ['Facebook', 'LinkedIn'], statut: 'refuse' })).json;
  await envoyerPhoto(a.id, 'meta', JPEG, 'image/jpeg');
  await envoyerPhoto(b.id, 'linkedin', PNG, 'image/png');
  const photoA = (await api('GET', `/api/posts/${a.id}`)).json.photos.meta.fichier;
  const photoLi = (await api('GET', `/api/posts/${b.id}`)).json.photos.linkedin.fichier;

  // On garde B : il conserve son identifiant, sa date et son titre
  const res = await api('POST', '/api/posts/fusionner', { ids: [a.id, b.id], garder: b.id, choix: { photo: 'aucune' } });
  assert.equal(res.status, 200);
  const p = res.json.post;
  assert.equal(p.id, b.id);
  assert.equal(res.json.supprime, a.id);
  assert.deepEqual(p.plateformes, ['Instagram', 'Facebook', 'LinkedIn']);
  assert.equal(p.titre, 'B');
  assert.equal(p.datePublication, '2026-11-12');
  assert.equal(p.description, 'Texte B');
  assert.equal(p.statut, 'idee', 'statuts différents sans choix : à re-valider');
  assert.equal(p.photos.meta, null, 'photo « aucune »');
  assert.equal(p.photos.linkedin.fichier, photoLi, 'la photo LinkedIn suit');
  assert.ok(!fichiersImages().includes(photoA), 'photo écartée effacée');
  assert.ok(fichiersImages().includes(photoLi));
  await api('DELETE', `/api/posts/${b.id}`);
});

test('fusionner : refus des cas invalides, sans rien modifier', async () => {
  const ig = (await api('POST', '/api/posts', { titre: 'IG', datePublication: '2026-11-13', plateformes: ['Instagram', 'Facebook'] })).json;
  const fb = (await api('POST', '/api/posts', { titre: 'FB', datePublication: '2026-11-13', plateformes: ['Facebook'] })).json;
  const li = (await api('POST', '/api/posts', { titre: 'LI', datePublication: '2026-11-13', plateformes: ['LinkedIn'] })).json;
  const nb = async () => (await api('GET', '/api/posts')).json.length;
  const avant = await nb();

  const commun = await api('POST', '/api/posts/fusionner', { ids: [ig.id, fb.id] });
  assert.equal(commun.status, 400);
  assert.match(commun.json.error, /Facebook/, 'réseau en commun nommé');
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id] })).status, 400);
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, ig.id] })).status, 400);
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, li.id, fb.id] })).status, 400);
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, 'po-inconnu'] })).status, 404);
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, li.id], garder: fb.id })).status, 400);
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, li.id], choix: { titre: fb.id } })).status, 400, 'choix hors des deux posts');
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, li.id], choix: { couleur: ig.id } })).status, 400, 'champ inconnu');
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, li.id], choix: { titre: 'aucune' } })).status, 400, '« aucune » seulement pour la photo');
  assert.equal(await nb(), avant, 'aucun post supprimé par les refus');

  // Une fusion qui réussit retire bien un post
  assert.equal((await api('POST', '/api/posts/fusionner', { ids: [ig.id, li.id] })).status, 200);
  assert.equal(await nb(), avant - 1);
  for (const id of [ig.id, fb.id]) await api('DELETE', `/api/posts/${id}`);
});

test('filtres de liste', async () => {
  const octobre = await api('GET', '/api/posts?du=2026-10-12&au=2026-10-18');
  assert.deepEqual(
    octobre.json.map((p) => p.datePublication),
    ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16'],
  );
  const recherche = await api('GET', '/api/posts?q=halloween');
  assert.ok(recherche.json.length >= 3);
  assert.equal((await api('GET', '/api/posts?statut=nimporte')).status, 400);
});

test('événements : validation et suppression qui détache les posts', async () => {
  assert.equal((await api('POST', '/api/evenements', { nom: 'X', dateDebut: '2026-11-10', dateFin: '2026-11-01' })).status, 400);
  const ev = (await api('POST', '/api/evenements', { nom: 'Téléthon', dateDebut: '2026-12-04', explication: 'Collecte' })).json;
  assert.equal(ev.dateFin, '2026-12-04'); // dateFin par défaut = dateDebut
  const post = (await api('POST', '/api/posts', {
    titre: 'Post Téléthon',
    datePublication: '2026-12-03',
    plateformes: ['Facebook'],
    eventId: ev.id,
  })).json;
  const del = await api('DELETE', `/api/evenements/${ev.id}`);
  assert.equal(del.json.postsDetaches, 1);
  assert.equal((await api('GET', `/api/posts/${post.id}`)).json.eventId, null);
});

test('export Excel : deux feuilles, dates réelles, filtre par statut', async () => {
  // aucun post validé au départ sauf po-20261001 (validé par le test précédent)
  const only = await api('GET', '/api/export.xlsx', undefined, { raw: true });
  assert.equal(only.status, 200);
  assert.match(only.headers.get('content-disposition'), /Calendrier_editorial_Elisa30.*\.xlsx/);
  assert.equal(only.headers.get('x-calendy-posts'), '1');

  // les tests précédents partagent la base : on compare au total réel (18 du seed + « Post Téléthon »)
  const total = (await api('GET', '/api/posts')).json.length;
  assert.equal(total, 19);
  const res = await api('GET', '/api/export.xlsx?statuts=all', undefined, { raw: true });
  assert.equal(Number(res.headers.get('x-calendy-posts')), total);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Calendrier éditorial', 'Événements']);

  const ws = wb.getWorksheet('Calendrier éditorial');
  assert.equal(ws.rowCount, total + 1); // en-tête + tous les posts
  const header = ws.getRow(1).values.slice(1);
  for (const col of ['Date de publication', 'Titre', 'Description / légende', 'Hashtags', 'Idée visuelle', 'Événement', "Date de l'événement", "Explication de l'événement", 'Statut']) {
    assert.ok(header.includes(col), `colonne manquante : ${col}`);
  }
  const first = ws.getRow(2);
  assert.ok(first.getCell(1).value instanceof Date);
  assert.equal(first.getCell(1).value.toISOString().slice(0, 10), '2026-10-01');
  assert.equal(first.getCell(2).value, 'Jeudi');
  assert.equal(first.getCell(4).value, 'S1 - 1 au 4 oct.');
  assert.equal(first.getCell(5).value, 'Instagram + Facebook');
  assert.equal(first.getCell(11).value, 'Octobre Rose');
  assert.equal(first.getCell(12).value, 'du 1er au 31 octobre 2026');
  assert.equal(first.getCell(16).value, 'Validé');

  const evs = wb.getWorksheet('Événements');
  assert.equal(evs.rowCount, 1 + 8); // les 8 événements sont référencés par au moins un post
  const periode = await api('GET', '/api/export.xlsx?statuts=all&du=2026-10-28&au=2026-10-31', undefined, { raw: true });
  assert.equal(periode.headers.get('x-calendy-posts'), '4');
});

test('routes inconnues', async () => {
  assert.equal((await api('GET', '/api/nimporte')).status, 404);
  assert.equal((await api('GET', '/api/posts/po-inexistant')).status, 404);
});
