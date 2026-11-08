'use strict';
// Teste le connecteur MCP de bout en bout : vrai serveur Calendy + vrai client MCP en stdio.
// MCP_ENTRY permet de tester la version empaquetée (dist/calendy-mcp.js) à la place de mcp.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const ExcelJS = require('exceljs');

const TOKEN = 'jeton-mcp-test';
const PORT = 3800 + Math.floor(Math.random() * 90);
const ENTRY = process.env.MCP_ENTRY ? path.resolve(process.env.MCP_ENTRY) : path.join(__dirname, '..', 'mcp.js');
let server;
let client;
let dataDir;
let exportDir;

// Petites images réelles (JPEG et PNG, 40×30) pour les tests de photos.
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnKKKK6T2wooooAKKKKACiiigAooooAKKKKAP/2Q==';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAO0lEQVR4Xu3QUQ0AMAyE0K5Kam12pnqpCe6HZ4CE8+ZWQieiyzDG1RhXY1yNcTXG1RhXY1yNcTUmtvoDgI8BR1lq6aUAAAAASUVORK5CYII=';

const texte = (res) => res.content[0].text;
const donnees = (res) => JSON.parse(texte(res));
const appel = (name, args = {}) => client.callTool({ name, arguments: args });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-mcp-data-'));
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-mcp-export-'));
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CALENDY_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
    server.on('exit', (c) => reject(new Error(`serveur arrêté (${c})`)));
    setTimeout(() => reject(new Error('démarrage trop long')), 30000).unref();
  });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, CALENDY_URL: `http://127.0.0.1:${PORT}`, CALENDY_TOKEN: TOKEN, CALENDY_EXPORT_DIR: exportDir },
    }),
  );
});

after(async () => {
  await client.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(exportDir, { recursive: true, force: true });
});

test('le connecteur annonce ses outils et ses consignes', async () => {
  const { tools } = await client.listTools();
  const noms = tools.map((t) => t.name).sort();
  assert.deepEqual(noms, [
    'ajouter_photo', 'apercu', 'changer_statut', 'cloner_post', 'creer_evenement', 'creer_post', 'deplacer_post', 'exporter_excel',
    'fusionner_posts', 'lire_post', 'lister_evenements', 'lister_posts', 'modifier_evenement', 'modifier_post', 'retirer_photo',
    'supprimer_evenement', 'supprimer_post', 'telecharger_photo',
  ]);
  assert.ok(tools.every((t) => t.description && t.description.length > 30), 'chaque outil est décrit');
  assert.equal(tools.find((t) => t.name === 'supprimer_post').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'lister_posts').annotations.readOnlyHint, true);
  assert.match(client.getInstructions(), /c'est l'utilisateur qui décide/);
});

test('apercu : état du calendrier', async () => {
  const data = donnees(await appel('apercu'));
  assert.equal(data.totalPosts, 18);
  assert.equal(data.parStatut.idee, 18);
  assert.equal(data.aValider.length, 18);
  assert.ok(Array.isArray(data.evenementsAVenirSansPost));
});

test('lister_posts : filtres et résumés', async () => {
  const data = donnees(await appel('lister_posts', { du: '2026-10-12', au: '2026-10-18' }));
  assert.equal(data.nombre, 4);
  assert.deepEqual(Object.keys(data.posts[0]).sort(), ['date', 'evenement', 'heure', 'id', 'reseaux', 'statut', 'titre']);
  assert.equal(data.posts[0].evenement, 'Semaine du Goût (37e édition)');
  const complet = donnees(await appel('lister_posts', { recherche: 'DuoDay', detail: true }));
  assert.ok(complet.posts[0].description.includes('DuoDay'));
});

test('lire_post : post complet avec son événement', async () => {
  const data = donnees(await appel('lire_post', { id: 'po-20261029' }));
  assert.equal(data.evenement.nom, 'DuoDay 2026');
  assert.match(data.hashtags, /#DuoDay2026/);
});

test('creer_post, modifier_post, changer_statut, supprimer_post', async () => {
  const cree = donnees(await appel('creer_post', {
    titre: 'Téléthon : on se mobilise',
    datePublication: '2026-12-04',
    plateformes: ['Instagram', 'LinkedIn'],
    hashtags: ['Téléthon', '#ESAT'],
    description: 'Texte de la légende',
  }));
  assert.equal(cree.statut, 'idee', 'un post créé par Claude reste une idée à valider');
  assert.equal(cree.hashtags, '#Téléthon #ESAT');

  const modifie = donnees(await appel('modifier_post', { id: cree.id, heure: '11:30', atelier: 'Transversal' }));
  assert.equal(modifie.heure, '11:30');
  assert.equal(modifie.titre, 'Téléthon : on se mobilise');

  const statut = donnees(await appel('changer_statut', { ids: [cree.id, 'po-20261001'], statut: 'valide' }));
  assert.equal(statut.modifies, 2);

  const supprime = donnees(await appel('supprimer_post', { id: cree.id }));
  assert.equal(supprime.supprime, cree.id);
});

test('deplacer_post, cloner_post, fusionner_posts', async () => {
  const ig = donnees(await appel('creer_post', { titre: 'Post Instagram', description: 'Texte IG', datePublication: '2026-11-20', plateformes: ['Instagram'] }));
  const fb = donnees(await appel('creer_post', { titre: 'Post Facebook', description: 'Texte FB', datePublication: '2026-11-20', plateformes: ['Facebook'] }));

  // Déplacer
  const deplace = donnees(await appel('deplacer_post', { id: ig.id, datePublication: '2026-11-23', heure: '10:15' }));
  assert.equal(deplace.date, '2026-11-23');
  assert.equal(deplace.heure, '10:15');
  assert.equal(deplace.statut, 'idee');
  const datemauvaise = await appel('deplacer_post', { id: ig.id, datePublication: '2026-02-30' });
  assert.equal(datemauvaise.isError, true);

  // Cloner : une copie par date, toujours « idee »
  await appel('changer_statut', { ids: [ig.id], statut: 'valide' });
  const clones = donnees(await appel('cloner_post', { id: ig.id, dates: ['2026-11-30', '2026-12-07'] }));
  assert.equal(clones.nombre, 2);
  assert.deepEqual(clones.copies.map((c) => [c.date, c.statut]), [['2026-11-30', 'idee'], ['2026-12-07', 'idee']]);
  assert.equal(donnees(await appel('lire_post', { id: ig.id })).statut, 'valide', 'l’original ne change pas');
  assert.equal((await appel('cloner_post', { id: 'po-inconnu', dates: ['2026-11-30'] })).isError, true);

  // Fusionner : un Instagram + un Facebook deviennent un seul post
  const fusion = donnees(await appel('fusionner_posts', { ids: [ig.id, fb.id], choix: { description: fb.id } }));
  assert.equal(fusion.supprime, fb.id);
  assert.deepEqual(fusion.post.reseaux, ['Instagram', 'Facebook']);
  assert.equal(donnees(await appel('lire_post', { id: ig.id })).description, 'Texte FB');
  assert.equal((await appel('lire_post', { id: fb.id })).isError, true, 'l’autre post n’existe plus');
  const commun = await appel('fusionner_posts', { ids: [ig.id, clones.copies[0].id] });
  assert.equal(commun.isError, true);
  assert.match(texte(commun), /Instagram/);

  for (const id of [ig.id, ...clones.copies.map((c) => c.id)]) await appel('supprimer_post', { id });
  assert.equal(donnees(await appel('apercu')).totalPosts, 18, 'rien ne traîne');
});

test('événements : création, lien avec un post, modification, suppression', async () => {
  const ev = donnees(await appel('creer_evenement', { nom: 'Téléthon', dateDebut: '2026-12-04', explication: 'Collecte nationale' }));
  assert.equal(ev.dateFin, '2026-12-04');
  const post = donnees(await appel('creer_post', { titre: 'Post Téléthon', datePublication: '2026-12-03', plateformes: ['Facebook'], eventId: ev.id }));
  const liste = donnees(await appel('lister_evenements', { du: '2026-12-01' }));
  assert.equal(liste.length, 1);
  donnees(await appel('modifier_evenement', { id: ev.id, dateFin: '2026-12-05' }));
  const detach = donnees(await appel('supprimer_evenement', { id: ev.id }));
  assert.equal(detach.postsDetaches, 1);
  assert.equal(donnees(await appel('lire_post', { id: post.id })).eventId, null);
});

test('ajouter_photo et retirer_photo : images d’un visuel, à partir d’un fichier local', async () => {
  const jpg = path.join(exportDir, 'photo.jpg');
  fs.writeFileSync(jpg, Buffer.from(JPEG_BASE64, 'base64'));
  const post = donnees(await appel('creer_post', { titre: 'Post MCP photo', datePublication: '2026-11-12', plateformes: ['Instagram', 'LinkedIn'] }));
  const ajoute = donnees(await appel('ajouter_photo', { id: post.id, visuel: 'instagram_facebook', chemin: jpg }));
  assert.equal(ajoute.photos.meta.length, 1);
  assert.equal(ajoute.photos.meta[0].type, 'image/jpeg');
  assert.deepEqual(ajoute.photos.linkedin, []);
  const lu = donnees(await appel('lire_post', { id: post.id }));
  assert.equal(lu.photos.meta.length, 1, 'la photo apparaît dans lire_post');

  const mauvais = await appel('ajouter_photo', { id: post.id, visuel: 'linkedin', chemin: path.join(exportDir, 'absent.jpg') });
  assert.equal(mauvais.isError, true);
  assert.match(texte(mauvais), /introuvable/);
  const gif = path.join(exportDir, 'photo.gif');
  fs.writeFileSync(gif, 'GIF89a');
  const refus = await appel('ajouter_photo', { id: post.id, visuel: 'linkedin', chemin: gif });
  assert.match(texte(refus), /\.jpg, \.jpeg ou \.png/);
  const faux = path.join(exportDir, 'faux.png');
  fs.writeFileSync(faux, 'ceci n’est pas une image');
  assert.equal((await appel('ajouter_photo', { id: post.id, visuel: 'linkedin', chemin: faux })).isError, true, 'contenu invalide refusé par le serveur');

  const telecharge = donnees(await appel('telecharger_photo', { id: post.id }));
  assert.equal(telecharge.fichiers.length, 1, 'seule la photo jointe est enregistrée');
  assert.equal(path.basename(telecharge.fichiers[0]), '2026-11-12_post-mcp-photo_instagram-facebook.jpg');
  assert.deepEqual(fs.readFileSync(telecharge.fichiers[0]), fs.readFileSync(jpg), 'fichier identique à la photo jointe');
  const encore = donnees(await appel('telecharger_photo', { id: post.id, visuel: 'instagram_facebook' }));
  assert.notEqual(encore.fichiers[0], telecharge.fichiers[0], 'un second téléchargement n’écrase pas le premier');
  const sansPhoto = await appel('telecharger_photo', { id: post.id, visuel: 'linkedin' });
  assert.equal(sansPhoto.isError, true);
  assert.match(texte(sansPhoto), /pas de photo/);

  const retire = donnees(await appel('retirer_photo', { id: post.id, visuel: 'instagram_facebook' }));
  assert.deepEqual(retire.photos.meta, [], 'une seule image : retirée sans autre précision');
  await appel('supprimer_post', { id: post.id });
});

test('carrousel : ajouter_photo à la suite, retirer_photo par numéro, telecharger_photo numérotées', async () => {
  const jpg = path.join(exportDir, 'carrousel.jpg');
  const png = path.join(exportDir, 'carrousel.png');
  fs.writeFileSync(jpg, Buffer.from(JPEG_BASE64, 'base64'));
  fs.writeFileSync(png, Buffer.from(PNG_BASE64, 'base64'));
  const post = donnees(await appel('creer_post', { titre: 'Post MCP carrousel', datePublication: '2026-11-13', plateformes: ['Instagram', 'Facebook'] }));
  const visuel = 'instagram_facebook';
  try {
    // Chaque appel ajoute une image à la suite, dans l'ordre
    donnees(await appel('ajouter_photo', { id: post.id, visuel, chemin: jpg }));
    donnees(await appel('ajouter_photo', { id: post.id, visuel, chemin: png }));
    const trois = donnees(await appel('ajouter_photo', { id: post.id, visuel, chemin: jpg }));
    assert.deepEqual(trois.photos.meta.map((f) => f.type), ['image/jpeg', 'image/png', 'image/jpeg']);
    assert.deepEqual(trois.photos.linkedin, []);

    // Téléchargement : toutes les images, numérotées dans l'ordre, identiques aux fichiers d'origine
    const dossier = path.join(exportDir, 'telechargement-carrousel');
    const telecharge = donnees(await appel('telecharger_photo', { id: post.id, dossier }));
    assert.deepEqual(
      telecharge.fichiers.map((f) => path.basename(f)),
      [
        '2026-11-13_post-mcp-carrousel_instagram-facebook_1.jpg',
        '2026-11-13_post-mcp-carrousel_instagram-facebook_2.png',
        '2026-11-13_post-mcp-carrousel_instagram-facebook_3.jpg',
      ],
    );
    assert.deepEqual(fs.readFileSync(telecharge.fichiers[1]), fs.readFileSync(png), 'la 2e image est bien le PNG');

    // Retirer : sans précision, refusé quand il y a plusieurs images (rien n'est supprimé par erreur)
    const ambigu = await appel('retirer_photo', { id: post.id, visuel });
    assert.equal(ambigu.isError, true);
    assert.match(texte(ambigu), /3 images/);
    assert.match(texte(ambigu), /numero/);
    assert.equal((await appel('retirer_photo', { id: post.id, visuel, numero: 4 })).isError, true, 'numéro hors du carrousel');
    assert.equal((await appel('retirer_photo', { id: post.id, visuel, numero: 1, toutes: true })).isError, true, 'numero et toutes ensemble');
    assert.equal(donnees(await appel('lire_post', { id: post.id })).photos.meta.length, 3, 'les refus ne retirent rien');

    // Retirer l'image numéro 2 (le PNG) : les deux JPEG restent, dans l'ordre
    const apres = donnees(await appel('retirer_photo', { id: post.id, visuel, numero: 2 }));
    assert.deepEqual(apres.photos.meta.map((f) => f.type), ['image/jpeg', 'image/jpeg']);

    // Remplacer : une seule image prend la place de tout le carrousel
    const remplace = donnees(await appel('ajouter_photo', { id: post.id, visuel, chemin: png, remplacer: true }));
    assert.deepEqual(remplace.photos.meta.map((f) => f.type), ['image/png']);

    // Tout vider d'un coup
    donnees(await appel('ajouter_photo', { id: post.id, visuel, chemin: jpg }));
    const vide = donnees(await appel('retirer_photo', { id: post.id, visuel, toutes: true }));
    assert.deepEqual(vide.photos.meta, []);
    assert.equal((await appel('retirer_photo', { id: post.id, visuel, numero: 1 })).isError, true, 'visuel vide : numéro refusé');
  } finally {
    await appel('supprimer_post', { id: post.id });
  }
});

test('erreurs : messages clairs plutôt que des plantages', async () => {
  const dateInvalide = await appel('creer_post', { titre: 'x', datePublication: '2026-02-30', plateformes: ['Instagram'] });
  assert.equal(dateInvalide.isError, true);
  assert.match(texte(dateInvalide), /date valide/);
  const inconnu = await appel('lire_post', { id: 'po-inexistant' });
  assert.equal(inconnu.isError, true);
  assert.match(texte(inconnu), /introuvable/i);
  // Le schéma refuse un réseau qui n'existe pas avant même d'appeler le serveur
  const mauvaisReseau = await appel('creer_post', { titre: 'x', datePublication: '2026-11-01', plateformes: ['TikTok'] });
  assert.equal(mauvaisReseau.isError, true);
});

test('exporter_excel : écrit le fichier dans le dossier demandé', async () => {
  const res = donnees(await appel('exporter_excel', { statuts: ['valide', 'publie'] }));
  assert.equal(res.posts, 1); // po-20261001 validé plus haut
  assert.ok(res.fichier.startsWith(exportDir));
  assert.ok(fs.existsSync(res.fichier));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(res.fichier);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Calendrier éditorial', 'Événements']);
  assert.equal(wb.getWorksheet('Calendrier éditorial').rowCount, 2);
  // un second export le même jour ne doit pas écraser le premier
  const encore = donnees(await appel('exporter_excel', { statuts: ['valide'] }));
  assert.notEqual(encore.fichier, res.fichier);
  assert.ok(fs.existsSync(res.fichier) && fs.existsSync(encore.fichier));
});

test('serveur injoignable ou jeton erroné : explication utile', async () => {
  const mauvais = new Client({ name: 'test2', version: '1.0.0' });
  await mauvais.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, CALENDY_URL: `http://127.0.0.1:${PORT}`, CALENDY_TOKEN: 'faux' },
    }),
  );
  const refuse = await mauvais.callTool({ name: 'apercu', arguments: {} });
  assert.equal(refuse.isError, true);
  assert.match(refuse.content[0].text, /CALENDY_TOKEN/);
  await mauvais.close();

  const absent = new Client({ name: 'test3', version: '1.0.0' });
  await absent.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, CALENDY_URL: 'http://127.0.0.1:1', CALENDY_TOKEN: TOKEN },
    }),
  );
  const injoignable = await absent.callTool({ name: 'apercu', arguments: {} });
  assert.equal(injoignable.isError, true);
  assert.match(injoignable.content[0].text, /injoignable/);
  await absent.close();
});

test('changer_statut : planifier un post à venir, refuser une date passée', async () => {
  const futur = donnees(await appel('creer_post', { titre: 'MCP à planifier', datePublication: '2099-05-05', heure: '10:00', plateformes: ['Instagram'] }));
  const planifie = donnees(await appel('changer_statut', { ids: [futur.id], statut: 'planifie' }));
  assert.equal(planifie.modifies, 1);
  assert.equal(planifie.statut, 'planifie');
  assert.equal(donnees(await appel('lire_post', { id: futur.id })).statut, 'planifie');
  const apercu = donnees(await appel('apercu'));
  assert.equal(apercu.parStatut.planifie, 1);
  assert.ok(apercu.prochainsPostsValides.some((p) => p.id === futur.id), 'un post planifié compte parmi les prochains posts');

  const passe = donnees(await appel('creer_post', { titre: 'MCP déjà passé', datePublication: '2020-05-05', plateformes: ['Instagram'] }));
  const refus = await appel('changer_statut', { ids: [passe.id], statut: 'planifie' });
  assert.equal(refus.isError, true);
  assert.match(refus.content[0].text, /déjà passées/);
  assert.equal(donnees(await appel('lire_post', { id: passe.id })).statut, 'idee');

  await appel('supprimer_post', { id: futur.id });
  await appel('supprimer_post', { id: passe.id });
});
