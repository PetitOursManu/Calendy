'use strict';
/* Historique Annuler / Rétablir et agent IA. Les fournisseurs d'IA sont simulés par un petit serveur local. */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'jeton-agent-0123456789';
const PORT = 5100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const CLE = 'sk-ant-secret-de-test';
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

let child;
let dataDir;
let fournisseur;
let portFournisseur;
let reponses = [];
let requetes = [];

async function api(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

const creerPost = async (titre, extra = {}) => (await api('POST', '/api/posts', { titre, datePublication: '2030-03-10', plateformes: ['Instagram'], ...extra })).json;
const appel = (nom, input, id = `t-${Math.random()}`) => ({ type: 'tool_use', id, name: nom, input });
const texte = (t) => ({ type: 'text', text: t });
const claude = (...content) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'x', stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 1, output_tokens: 1 } });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-agent-'));
  fournisseur = http.createServer((req, res) => {
    const morceaux = [];
    req.on('data', (c) => morceaux.push(c));
    req.on('end', () => {
      requetes.push({ url: req.url, headers: req.headers, body: morceaux.length ? JSON.parse(Buffer.concat(morceaux)) : null });
      const r = reponses.shift();
      const statut = r && r.__statut ? r.__statut : 200;
      res.writeHead(statut, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r || claude(texte('(fin)'))));
    });
  });
  await new Promise((r) => fournisseur.listen(0, '127.0.0.1', r));
  portFournisseur = fournisseur.address().port;
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CALENDY_TOKEN: TOKEN, CALENDY_NO_SEED: '1', CALENDY_ANTHROPIC_URL: `http://127.0.0.1:${portFournisseur}`, CALENDY_OPENROUTER_URL: `http://127.0.0.1:${portFournisseur}/or` };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
    child.on('exit', (code) => reject(new Error(`serveur arrêté (code ${code})`)));
    setTimeout(() => reject(new Error('démarrage trop long')), 30000).unref();
  });
});

after(() => {
  child.kill();
  fournisseur.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => { reponses = []; requetes = []; });

/* ---------- historique ---------- */

test('annuler puis rétablir un déplacement', async () => {
  const p = await creerPost('À déplacer');
  await api('PUT', `/api/posts/${p.id}`, { datePublication: '2030-04-01' });
  const etat = (await api('GET', '/api/state')).json.historique;
  assert.match(etat.annuler.libelle, /Déplacement/);
  assert.equal((await api('POST', '/api/historique/annuler', {})).status, 200);
  assert.equal((await api('GET', `/api/posts/${p.id}`)).json.datePublication, '2030-03-10');
  assert.equal((await api('POST', '/api/historique/retablir', {})).status, 200);
  assert.equal((await api('GET', `/api/posts/${p.id}`)).json.datePublication, '2030-04-01');
});

test('une nouvelle modification vide la pile Rétablir', async () => {
  const p = await creerPost('Pile rétablir');
  await api('POST', '/api/historique/annuler', {});
  assert.ok((await api('GET', '/api/historique')).json.retablir);
  await creerPost('Autre');
  assert.equal((await api('GET', '/api/historique')).json.retablir, null);
  assert.equal((await api('GET', `/api/posts/${p.id}`)).status, 404);
});

test('annuler une suppression restaure le post et ses images', async () => {
  const p = await creerPost('Avec image');
  const { json: avecImage } = await api('POST', `/api/posts/${p.id}/photo/meta`, JPEG, { 'Content-Type': 'image/jpeg' });
  const fichier = avecImage.photos.meta[0].fichier;
  await api('DELETE', `/api/posts/${p.id}`);
  assert.equal((await api('GET', `/api/posts/${p.id}`)).status, 404);
  assert.ok(fs.existsSync(path.join(dataDir, 'images', fichier)), 'image gardée tant qu’on peut annuler');
  await api('POST', '/api/historique/annuler', {});
  assert.equal((await api('GET', `/api/posts/${p.id}`)).json.photos.meta[0].fichier, fichier);
  const image = await fetch(`${BASE}/api/posts/${p.id}/photo/meta/${fichier}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(image.status, 200);
});

test('annuler la suppression d’un événement rattache ses posts', async () => {
  const { json: ev } = await api('POST', '/api/evenements', { nom: 'Fête', dateDebut: '2030-05-01' });
  const p = await creerPost('Lié', { eventId: ev.id });
  await api('DELETE', `/api/evenements/${ev.id}`);
  assert.equal((await api('GET', `/api/posts/${p.id}`)).json.eventId, null);
  await api('POST', '/api/historique/annuler', {});
  assert.equal((await api('GET', `/api/posts/${p.id}`)).json.eventId, ev.id);
});

test('une image sortie de l’historique est effacée du disque', async () => {
  const p = await creerPost('Image oubliée');
  const { json } = await api('POST', `/api/posts/${p.id}/photo/meta`, JPEG, { 'Content-Type': 'image/jpeg' });
  const fichier = json.photos.meta[0].fichier;
  await api('DELETE', `/api/posts/${p.id}/photo/meta/${fichier}`);
  assert.ok(fs.existsSync(path.join(dataDir, 'images', fichier)));
  for (let i = 0; i < 100; i++) await api('PUT', `/api/posts/${p.id}`, { titre: `Image oubliée ${i}` });
  assert.ok(!fs.existsSync(path.join(dataDir, 'images', fichier)));
});

test('une requête refusée n’entre pas dans l’historique', async () => {
  const avant = (await api('GET', '/api/historique')).json;
  assert.equal((await api('POST', '/api/posts', { titre: '' })).status, 400);
  assert.deepEqual((await api('GET', '/api/historique')).json, avant);
});

/* ---------- réglages ---------- */

test('réglages : la clé n’est jamais renvoyée et un message sans clé est refusé proprement', async () => {
  const sansCle = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Salut' }] });
  assert.equal(sansCle.status, 400);
  assert.match(sansCle.json.error, /clé API/i);
  const r = await api('PUT', '/api/agent/reglages', { cles: { anthropic: CLE }, modeles: { anthropic: 'claude-haiku-5-5' }, instructions: 'Vouvoie toujours.' });
  assert.equal(r.status, 200);
  assert.equal(r.json.cles.anthropic.definie, true);
  assert.ok(!r.text.includes(CLE));
  assert.ok(!(await api('GET', '/api/agent/reglages')).text.includes(CLE));
  assert.ok(!(await api('GET', '/api/state')).text.includes(CLE));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8').includes(CLE));
});

test('réglages : valeurs invalides refusées', async () => {
  assert.equal((await api('PUT', '/api/agent/reglages', { fournisseur: 'autre' })).status, 400);
  assert.equal((await api('PUT', '/api/agent/reglages', { modeles: { anthropic: 'a b' } })).status, 400);
});

test('nom de la structure : vide par défaut, repris dans l’état, l’export et l’agent', async () => {
  assert.deepEqual((await api('GET', '/api/reglages')).json, { structure: '' });
  assert.equal((await api('GET', '/api/state')).json.structure, '');
  const nomExport = async () => {
    const res = await fetch(`${BASE}/api/export.xlsx?statuts=all`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return decodeURIComponent(res.headers.get('content-disposition').match(/filename\*=UTF-8''([^;]+)/)[1]);
  };
  await creerPost('Pour export');
  assert.match(await nomExport(), /^Calendrier_editorial_\d{4}/);

  assert.equal((await api('PUT', '/api/reglages', { structure: '  Maison  de quartier é ' })).json.structure, 'Maison de quartier é');
  assert.equal((await api('GET', '/api/state')).json.structure, 'Maison de quartier é');
  assert.match(await nomExport(), /^Calendrier_editorial_Maison_de_quartier_e_\d{4}/);
  reponses = [claude(texte('Ok.'))];
  await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Salut' }] });
  assert.match(JSON.stringify(requetes[0].body.system), /Tu travailles pour : Maison de quartier é/);

  assert.equal((await api('PUT', '/api/reglages', { structure: 'x'.repeat(81) })).status, 400);
  assert.equal((await api('PUT', '/api/reglages', { structure: '' })).json.structure, '');
});

/* ---------- agent ---------- */

test('agent Claude : crée un post, envoie la clé, les consignes et le contexte', async () => {
  reponses = [
    claude(texte('Je le crée.'), appel('creer_post', { titre: 'Portes ouvertes', datePublication: '2030-06-12', plateformes: ['Facebook'] })),
    claude(texte('Post créé pour le 12 juin.')),
  ];
  const r = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Ajoute un post' }], contexte: { vue: 'calendrier', mois: '2030-06' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.reponse, 'Post créé pour le 12 juin.');
  assert.equal(r.json.actions.length, 1);
  assert.match(`${requetes[0].headers['x-api-key']} ${requetes[0].headers.authorization}`, new RegExp(CLE));
  assert.match(JSON.stringify(requetes[0].body.system), /Vouvoie toujours/);
  assert.ok(requetes[0].body.tools.some((t) => t.name === 'modifier_post'));
  assert.equal(requetes[1].body.messages.at(-1).content[0].type, 'tool_result');
  const cree = (await api('GET', '/api/posts?q=Portes')).json[0];
  assert.equal(cree.statut, 'idee');
  assert.equal((await api('GET', '/api/historique')).json.annuler.source, 'agent');
});

test('agent : les actions d’un même message s’annulent d’un seul coup', async () => {
  const a = await creerPost('Lot A');
  const b = await creerPost('Lot B');
  reponses = [
    claude(appel('modifier_post', { id: a.id, datePublication: '2030-07-01' }), appel('changer_statut', { ids: [b.id], statut: 'valide' })),
    claude(texte('Fait.')),
  ];
  await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Go' }] });
  assert.equal((await api('GET', `/api/posts/${b.id}`)).json.statut, 'valide');
  await api('POST', '/api/historique/annuler', {});
  assert.equal((await api('GET', `/api/posts/${a.id}`)).json.datePublication, '2030-03-10');
  assert.equal((await api('GET', `/api/posts/${b.id}`)).json.statut, 'idee');
});

test('agent : une erreur d’outil est rendue au modèle, sans modification', async () => {
  const p = await creerPost('Mauvaise date');
  reponses = [claude(appel('modifier_post', { id: p.id, datePublication: 'demain' })), claude(texte('Date invalide.'))];
  const r = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Go' }] });
  assert.deepEqual(r.json.actions, []);
  const res = requetes[1].body.messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /date valide/);
});

test('agent : la suppression attend la confirmation de l’utilisateur', async () => {
  const p = await creerPost('À supprimer');
  reponses = [claude(appel('supprimer_post', { id: p.id })), claude(texte('Confirme avec le bouton.'))];
  const r = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Supprime' }] });
  assert.equal(r.json.confirmations.length, 1);
  assert.equal((await api('GET', `/api/posts/${p.id}`)).status, 200, 'pas encore supprimé');
  const id = r.json.confirmations[0].id;
  assert.equal((await api('POST', '/api/agent/confirmer', { id, accepter: true })).json.fait, true);
  assert.equal((await api('GET', `/api/posts/${p.id}`)).status, 404);
  assert.equal((await api('POST', '/api/agent/confirmer', { id, accepter: true })).status, 410, 'usage unique');
  await api('POST', '/api/historique/annuler', {});
  assert.equal((await api('GET', `/api/posts/${p.id}`)).status, 200);
});

test('agent : un refus de confirmation laisse le post intact', async () => {
  const p = await creerPost('À garder');
  reponses = [claude(appel('supprimer_post', { id: p.id })), claude(texte('Ok.'))];
  const r = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Supprime' }] });
  await api('POST', '/api/agent/confirmer', { id: r.json.confirmations[0].id, accepter: false });
  assert.equal((await api('GET', `/api/posts/${p.id}`)).status, 200);
});

test('agent : un outil désactivé dans les réglages n’est ni proposé ni exécuté', async () => {
  await api('PUT', '/api/agent/reglages', { permissions: { supprimer: false } });
  const p = await creerPost('Protégé');
  reponses = [claude(appel('supprimer_post', { id: p.id })), claude(texte('Impossible.'))];
  const r = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Supprime' }] });
  assert.ok(!requetes[0].body.tools.some((t) => t.name === 'supprimer_post'));
  assert.deepEqual(r.json.confirmations, []);
  await api('PUT', '/api/agent/reglages', { permissions: { supprimer: true } });
});

test('agent : voir_images_post transmet l’image au modèle', async () => {
  const p = await creerPost('Photo à voir');
  await api('POST', `/api/posts/${p.id}/photo/meta`, JPEG, { 'Content-Type': 'image/jpeg' });
  reponses = [claude(appel('voir_images_post', { id: p.id })), claude(texte('Je vois.'))];
  await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Regarde' }] });
  const bloc = requetes[1].body.messages.at(-1).content[0].content;
  assert.equal(bloc[1].type, 'image');
  assert.equal(bloc[1].source.data, JPEG.toString('base64'));
});

test('agent : post ouvert en création, le formulaire est rempli sans rien enregistrer', async () => {
  const nb = (await api('GET', '/api/posts')).json.length;
  reponses = [claude(appel('remplir_formulaire', { titre: 'Brouillon', hashtags: '#ESAT' })), claude(texte('Rempli.'))];
  const r = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Remplis' }], contexte: { ouvert: { type: 'post', id: null, valeurs: { titre: '' } } } });
  assert.deepEqual(r.json.formulaire, { titre: 'Brouillon', hashtags: '#ESAT' });
  assert.equal((await api('GET', '/api/posts')).json.length, nb);
});

test('agent : les fiches ouvertes sont transmises dans le contexte', async () => {
  const p = await creerPost('Faute');
  reponses = [claude(texte('Vu.'))];
  await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Corrige' }], contexte: { ouvert: { type: 'post', id: p.id, valeurs: { description: 'Un text avec une fote' } } } });
  assert.match(JSON.stringify(requetes[0].body.system), /Un text avec une fote/);
});

test('agent : une clé refusée donne un message clair, pas un 401 qui redemanderait le jeton', async () => {
  reponses = [{ __statut: 401, type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }];
  const r = await api('POST', '/api/agent/tester', {});
  assert.equal(r.status, 502);
  assert.match(r.json.error, /Clé API refusée/);
});

test('agent OpenRouter : boucle d’outils au format OpenAI', async () => {
  await api('PUT', '/api/agent/reglages', { fournisseur: 'openrouter', cles: { openrouter: 'sk-or-test' }, modeles: { openrouter: 'anthropic/claude-test' } });
  const p = await creerPost('Via OpenRouter');
  reponses = [
    { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'changer_statut', arguments: JSON.stringify({ ids: [p.id], statut: 'valide' }) } }] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'Validé !' } }] },
  ];
  const r = await api('POST', '/api/agent/message', { messages: [{ role: 'user', content: 'Valide' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.reponse, 'Validé !');
  assert.equal(requetes[0].url, '/or/chat/completions');
  assert.equal(requetes[0].headers.authorization, 'Bearer sk-or-test');
  assert.equal(requetes[0].body.messages[0].role, 'system');
  assert.deepEqual(requetes[1].body.messages.at(-1).role, 'tool');
  assert.equal((await api('GET', `/api/posts/${p.id}`)).json.statut, 'valide');
  await api('PUT', '/api/agent/reglages', { fournisseur: 'anthropic' });
});
