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
    setTimeout(() => reject(new Error('démarrage trop long')), 8000);
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
    'ajouter_photo', 'apercu', 'changer_statut', 'creer_evenement', 'creer_post', 'exporter_excel', 'lire_post',
    'lister_evenements', 'lister_posts', 'modifier_evenement', 'modifier_post', 'retirer_photo', 'supprimer_evenement', 'supprimer_post',
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

test('ajouter_photo et retirer_photo : une photo par visuel, à partir d’un fichier local', async () => {
  const jpg = path.join(exportDir, 'photo.jpg');
  fs.writeFileSync(jpg, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnKKKK6T2wooooAKKKKACiiigAooooAKKKKAP/2Q==', 'base64'));
  const post = donnees(await appel('creer_post', { titre: 'Post MCP photo', datePublication: '2026-11-12', plateformes: ['Instagram', 'LinkedIn'] }));
  const ajoute = donnees(await appel('ajouter_photo', { id: post.id, visuel: 'instagram_facebook', chemin: jpg }));
  assert.equal(ajoute.photos.meta.type, 'image/jpeg');
  assert.equal(ajoute.photos.linkedin, null);
  const lu = donnees(await appel('lire_post', { id: post.id }));
  assert.ok(lu.photos.meta, 'la photo apparaît dans lire_post');

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

  const retire = donnees(await appel('retirer_photo', { id: post.id, visuel: 'instagram_facebook' }));
  assert.equal(retire.photos.meta, null);
  await appel('supprimer_post', { id: post.id });
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
