'use strict';
/* Visuels Mocky : Calendy parle à un faux Mocky (vrai serveur MCP du SDK, outils simulés) et range le PNG et le fichier Canva. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { cleTheme } = require('../mocky.js');

const TOKEN = 'jeton-mocky-0123456789';
const PORT = 5200 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const CLE = 'mocky_ak_cle-secrete-de-test';
// Un PNG 1×1 et un « .pptx » (une archive zip vide suffit pour la vérification de signature).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PPTX = Buffer.from('504b030414000000080000000000', 'hex');

let child;
let dataDir;
let mocky;
let portMocky;
const appels = [];
const requetesIa = [];
let ecran = 0;

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binaire */ }
  return { status: res.status, json, buf, headers: res.headers };
}

function fauxMocky() {
  const server = new McpServer({ name: 'mocky', version: '1.0.0' });
  const ok = (structured) => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: structured });
  const garder = (name) => (args) => { appels.push({ name, args }); return null; };
  server.registerTool('list_templates', { inputSchema: {} }, async () => { garder('list_templates')({}); return ok({ templates: [{ id: 'tcuisine', name: 'Cuisine', screens: 2 }, { id: 'trose', name: 'Octobre Rose', screens: 1 }] }); });
  const design = { brief: z.string(), follow_layout: z.boolean().optional(), page_format: z.string().optional(), style: z.string().optional(), screen_type: z.string().optional(), screen_name: z.string().optional(), kind: z.string().optional(), audience: z.string().optional(), engine: z.string().optional(), picture_subject: z.string().optional() };
  server.registerTool('create_design', { inputSchema: { ...design, project_name: z.string().optional(), template_id: z.string().optional() } }, async (args) => {
    garder('create_design')(args);
    if (args.engine === 'client') {
      // Comme Mocky (contractResult) : ses règles, puis la demande, et un travail qui attend le code.
      return { content: [{ type: 'text', text: 'Mocky a tout préparé.\n\n## RÈGLES (le système de Mocky)\nREGLES-DE-MOCKY\nLAYOUT MODEL — code du modèle : <Doc>MODELE</Doc>\n\n## DEMANDE\nDEMANDE-DU-POST' }], structuredContent: { status: 'awaiting_code', jobId: 'job-client', round: 0 } };
    }
    // Première réponse : encore en cours, comme un vrai design qui dépasse 40 s.
    return ok({ status: 'running', jobId: `job-${++ecran}` });
  });
  server.registerTool('add_screen', { inputSchema: { ...design, project_id: z.string() } }, async (args) => {
    garder('add_screen')(args);
    return ok({ status: 'done', projectId: args.project_id, screenId: `s${++ecran}`, link: `http://mocky.test/p/${args.project_id}?screen=s${ecran}` });
  });
  server.registerTool('submit_screen', { inputSchema: { job_id: z.string(), code: z.string() } }, async (args) => {
    garder('submit_screen')(args);
    // Le premier envoi « ne s'affiche pas » : Calendy doit faire corriger CETTE erreur, puis renvoyer.
    if (appels.filter((a) => a.name === 'submit_screen').length === 1) {
      return { content: [{ type: 'text', text: 'Le code soumis ne s’affiche pas.' }], structuredContent: { status: 'awaiting_code', jobId: args.job_id, round: 1, renderError: 'ReferenceError: Foo is not defined' } };
    }
    return ok({ status: 'done', projectId: 'p-client', screenId: 's-client', link: 'http://mocky.test/p/p-client?screen=s-client' });
  });
  server.registerTool('get_design', { inputSchema: { job_id: z.string() } }, async (args) => {
    garder('get_design')(args);
    return ok({ status: 'done', projectId: 'p-post', screenId: `s-${args.job_id}`, link: `http://mocky.test/p/p-post?screen=s-${args.job_id}` });
  });
  server.registerTool('edit_design', { inputSchema: { project_id: z.string(), screen_id: z.string(), instruction: z.string() } }, async (args) => {
    garder('edit_design')(args);
    return ok({ status: 'done', projectId: args.project_id, screenId: args.screen_id, link: 'http://mocky.test/edit' });
  });
  server.registerTool('export_screen', { inputSchema: { project_id: z.string(), screen_id: z.string(), format: z.string() } }, async (args) => {
    garder('export_screen')(args);
    const ext = args.format === 'png' ? 'png' : 'pptx';
    // Comme le vrai Mocky : un lien signé sur SON adresse publique, que le serveur de Calendy ne joint pas forcément.
    return ok({ download: `https://mocky.public.invalid/mcp-export/${'a'.repeat(64)}.${ext}?e=1&s=sig`, filename: ext === 'png' ? 'Post.png' : 'Post - Canva.pptx', format: args.format });
  });
  return server;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendy-mocky-'));
  mocky = http.createServer(async (req, res) => {
    if (req.url.startsWith('/mcp-export/') && req.url.includes('.png?')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (req.url.startsWith('/mcp-export/') && req.url.includes('.pptx?')) { res.writeHead(200); return res.end(PPTX); }
    if (req.url === '/v1/messages' && req.method === 'POST') {
      const morceauxIa = [];
      for await (const c of req) morceauxIa.push(c);
      const corps = JSON.parse(Buffer.concat(morceauxIa).toString('utf8'));
      requetesIa.push(corps);
      const code = requetesIa.length === 1 ? 'export default function App(){ return <Doc>PREMIER</Doc> }' : 'export default function App(){ return <Doc>CORRIGE</Doc> }';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: code }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== `Bearer ${CLE}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"invalid_token"}'); }
    const morceaux = [];
    for await (const c of req) morceaux.push(c);
    const server = fauxMocky();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(morceaux).toString('utf8')));
  });
  await new Promise((r) => mocky.listen(0, '127.0.0.1', r));
  portMocky = mocky.address().port;
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CALENDY_TOKEN: TOKEN, CALENDY_NO_SEED: '1', CALENDY_ANTHROPIC_URL: `http://127.0.0.1:${portMocky}` };
  delete env.ANTHROPIC_API_KEY;
  delete env.MOCKY_URL;
  delete env.MOCKY_API_KEY;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('prêt') && resolve());
    child.on('exit', (code) => reject(new Error(`serveur arrêté (code ${code})`)));
    setTimeout(() => reject(new Error('démarrage trop long')), 30000).unref();
  });
});

after(() => {
  child.kill();
  mocky.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function finDeTache(id) {
  for (let i = 0; i < 100; i++) {
    const t = (await api('GET', `/api/mocky/taches/${id}`)).json;
    if (t.etat !== 'en_cours') return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('tâche jamais finie');
}

test('thèmes comparés sans majuscules ni accents', () => {
  assert.equal(cleTheme('  Espaces   Verts '), cleTheme('espaces verts'));
  assert.equal(cleTheme('Éducation'), 'education');
});

test('réglages : la clé n’est jamais renvoyée, et doit être une clé d’assistant', async () => {
  assert.equal((await api('GET', '/api/mocky/reglages')).json.pret, false);
  assert.equal((await api('PUT', '/api/mocky/reglages', { cle: 'sk-autre' })).status, 400);
  assert.equal((await api('PUT', '/api/mocky/reglages', { url: 'ftp://x' })).status, 400);
  const r = await api('PUT', '/api/mocky/reglages', { url: `http://127.0.0.1:${portMocky}/`, cle: CLE });
  assert.equal(r.json.pret, true);
  assert.equal(r.json.cle.definie, true);
  assert.ok(!JSON.stringify(r.json).includes(CLE));
  const test2 = await api('POST', '/api/mocky/tester', {});
  assert.equal(test2.status, 200);
  assert.deepEqual(test2.json.modeles.map((m) => m.nom), ['Cuisine', 'Octobre Rose']);
});

test('le modèle se choisit par événement, puis par thème, puis par défaut', async () => {
  const ev = (await api('POST', '/api/evenements', { nom: 'Octobre Rose', dateDebut: '2030-10-01', dateFin: '2030-10-31' })).json;
  await api('PUT', '/api/mocky/reglages', { modeleDefaut: 'tdefaut', themes: [{ theme: 'Cuisine', modele: 'tcuisine' }], evenements: { [ev.id]: 'trose' } });
  const creer = async (extra) => (await api('POST', '/api/posts', { titre: 'P', datePublication: '2030-10-10', plateformes: ['Instagram'], ...extra })).json;
  const modele = async (p) => (await api('GET', `/api/posts/${p.id}/mocky/modele`)).json;
  assert.deepEqual(await modele(await creer({ eventId: ev.id, atelier: 'Cuisine' })), { modele: 'trose', raison: 'evenement' });
  assert.deepEqual(await modele(await creer({ atelier: 'cuisine ' })), { modele: 'tcuisine', raison: 'theme' });
  assert.deepEqual(await modele(await creer({ atelier: 'Autre' })), { modele: 'tdefaut', raison: 'defaut' });
});

test('créer un visuel : un projet par post depuis le modèle, PNG dans les images, fichier Canva à télécharger', async () => {
  const p = (await api('POST', '/api/posts', { titre: 'Semaine du goût', datePublication: '2030-10-12', plateformes: ['Instagram', 'Facebook', 'LinkedIn'], atelier: 'Cuisine', description: 'Venez goûter !', imageIdee: 'des légumes de saison' })).json;
  appels.length = 0;
  const lance = await api('POST', `/api/posts/${p.id}/mocky`, { visuel: 'meta' });
  assert.equal(lance.status, 202);
  assert.equal((await api('POST', `/api/posts/${p.id}/mocky`, { visuel: 'linkedin' })).status, 409, 'une seule création à la fois');
  const fin = await finDeTache(lance.json.id);
  assert.equal(fin.etat, 'fini', fin.message);

  const creation = appels.find((a) => a.name === 'create_design').args;
  assert.equal(creation.template_id, 'tcuisine');
  assert.equal(creation.screen_type, 'instagram');
  assert.match(creation.brief, /Semaine du goût/);
  assert.match(creation.brief, /Venez goûter/);
  assert.equal(creation.picture_subject, 'des légumes de saison');
  assert.ok(appels.some((a) => a.name === 'get_design'), 'attend la fin du travail');
  assert.deepEqual(appels.filter((a) => a.name === 'export_screen').map((a) => a.args.format), ['png', 'pptx-edit']);

  const post = (await api('GET', `/api/posts/${p.id}`)).json;
  assert.equal(post.mocky.projet, 'p-post');
  // Le lien montré est celui que Mocky donne (son adresse publique), pas l'adresse des réglages.
  assert.equal(post.mocky.lien, 'http://mocky.test/p/p-post');
  assert.equal(post.photos.meta.length, 1);
  assert.equal(post.photos.meta[0].type, 'image/png');
  assert.equal(post.photos.meta[0].source, 'mocky');
  const image = await api('GET', `/api/posts/${p.id}/photo/meta`);
  assert.ok(image.buf.equals(PNG));
  const canva = await api('GET', `/api/posts/${p.id}/canva/meta`);
  assert.equal(canva.status, 200);
  assert.ok(canva.buf.equals(PPTX));
  assert.match(canva.headers.get('content-disposition'), /Canva\.pptx/);
  assert.match((await api('GET', '/api/historique')).json.annuler.libelle, /Visuel Mocky/);

  // Le second réseau va dans le MÊME projet Mocky.
  appels.length = 0;
  const li = await finDeTache((await api('POST', `/api/posts/${p.id}/mocky`, { visuel: 'linkedin' })).json.id);
  assert.equal(li.etat, 'fini', li.message);
  const ajout = appels.find((a) => a.name === 'add_screen');
  assert.equal(ajout.args.project_id, 'p-post');
  assert.equal(ajout.args.screen_type, 'linkedin');
  assert.equal(ajout.args.follow_layout, true, 'même composition que le premier visuel du post');
  assert.ok(!appels.some((a) => a.name === 'create_design'));

  // Une modification remplace le PNG au même endroit, sans en ajouter un.
  appels.length = 0;
  const avant = (await api('GET', `/api/posts/${p.id}`)).json;
  const mod = await finDeTache((await api('POST', `/api/posts/${p.id}/mocky`, { visuel: 'meta', action: 'modifier', instruction: 'Titre plus gros' })).json.id);
  assert.equal(mod.etat, 'fini', mod.message);
  assert.deepEqual(appels.find((a) => a.name === 'edit_design').args, { project_id: 'p-post', screen_id: avant.mocky.visuels.meta.ecran, instruction: 'Titre plus gros' });
  const apres = (await api('GET', `/api/posts/${p.id}`)).json;
  assert.equal(apres.photos.meta.length, 1);
  assert.notEqual(apres.photos.meta[0].fichier, avant.photos.meta[0].fichier);

  // Annuler revient au visuel précédent, fichier Canva compris.
  await api('POST', '/api/historique/annuler', {});
  const annule = (await api('GET', `/api/posts/${p.id}`)).json;
  assert.equal(annule.photos.meta[0].fichier, avant.photos.meta[0].fichier);
  assert.equal(annule.mocky.visuels.meta.canva, avant.mocky.visuels.meta.canva);
  assert.equal((await api('GET', `/api/posts/${p.id}/canva/meta`)).status, 200);

  // Une copie du post n'est pas liée au projet Mocky de l'original.
  const copie = (await api('POST', `/api/posts/${p.id}/cloner`, { dates: ['2030-11-01'] })).json.clones[0];
  assert.equal(copie.mocky, undefined);
  assert.equal(copie.photos.meta[0].source, undefined);
});

test('un Mocky qui ne répond pas donne vite une erreur claire, en JSON', async () => {
  // Accepte la connexion et ne répond jamais : le cas qui renvoyait la page HTML du proxy devant Calendy.
  const muet = http.createServer(() => {});
  await new Promise((r) => muet.listen(0, '127.0.0.1', r));
  try {
    await api('PUT', '/api/mocky/reglages', { url: `http://127.0.0.1:${muet.address().port}` });
    const debut = Date.now();
    const r = await api('POST', '/api/mocky/tester', {});
    assert.equal(r.status, 424, 'jamais 502 ni 504 : un proxy les remplacerait par sa page HTML');
    assert.match(r.json.error, /délai dépassé/);
    assert.ok(Date.now() - debut < 30000, 'avant le délai habituel d’un proxy');
  } finally {
    muet.closeAllConnections();
    muet.close();
    await api('PUT', '/api/mocky/reglages', { url: `http://127.0.0.1:${portMocky}/` });
  }
});

test('le test de connexion dit quand Mocky est trop ancien (outils absents)', async () => {
  const ancien = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const morceaux = [];
    for await (const c of req) morceaux.push(c);
    const server = new McpServer({ name: 'mocky', version: '1.0.0' });
    // Un Mocky d'avant les exports : create_design et les autres, mais ni list_templates ni export_screen.
    for (const nom of ['create_design', 'add_screen', 'get_design', 'edit_design']) server.registerTool(nom, { inputSchema: { x: z.string().optional() } }, async () => ({ content: [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(morceaux).toString('utf8')));
  });
  await new Promise((r) => ancien.listen(0, '127.0.0.1', r));
  try {
    await api('PUT', '/api/mocky/reglages', { url: `http://127.0.0.1:${ancien.address().port}` });
    const r = await api('POST', '/api/mocky/tester', {});
    assert.equal(r.status, 424);
    assert.match(r.json.error, /ne propose pas : list_templates, export_screen/);
    assert.match(r.json.error, /Coolify/);
  } finally {
    ancien.close();
    await api('PUT', '/api/mocky/reglages', { url: `http://127.0.0.1:${portMocky}/` });
  }
});

test('réglages : formats, rédacteur et consignes', async () => {
  assert.equal((await api('PUT', '/api/mocky/reglages', { formats: { meta: 'a4' } })).status, 400);
  assert.equal((await api('PUT', '/api/mocky/reglages', { redacteur: 'autre' })).status, 400);
  assert.equal((await api('PUT', '/api/mocky/reglages', { consignes: 'x'.repeat(3001) })).status, 400);
  const r = (await api('PUT', '/api/mocky/reglages', { formats: { meta: 'social-square' }, consignes: ' Fond clair. ' })).json;
  assert.deepEqual(r.formats, { meta: 'social-square', linkedin: '' });
  assert.equal(r.consignes, 'Fond clair.');
  assert.equal(r.redacteur, 'mocky', 'Mocky écrit par défaut');
});

test('l’agent IA de Calendy écrit le visuel : il recopie le modèle, corrige une erreur de rendu, et envoie le code à Mocky', async () => {
  await api('PUT', '/api/agent/reglages', { cles: { anthropic: 'sk-ant-test' }, modeles: { anthropic: 'claude-test' } });
  await api('PUT', '/api/mocky/reglages', { redacteur: 'calendy', formats: { meta: 'social-square' }, consignes: 'Fond blanc lumineux, une seule photo.' });
  const p = (await api('POST', '/api/posts', { titre: 'Coffrets', datePublication: '2030-12-01', plateformes: ['Instagram'] })).json;
  appels.length = 0;
  requetesIa.length = 0;
  const fin = await finDeTache((await api('POST', `/api/posts/${p.id}/mocky`, { visuel: 'meta' })).json.id);
  assert.equal(fin.etat, 'fini', fin.message);

  const creation = appels.find((a) => a.name === 'create_design').args;
  assert.equal(creation.engine, 'client');
  assert.equal(creation.page_format, 'social-square');
  assert.equal(creation.style, 'Fond blanc lumineux, une seule photo.');

  // Le modèle de l'agent a reçu les règles de Mocky (avec le code du modèle), les consignes et la consigne de copie.
  const [premier, second] = requetesIa;
  assert.match(premier.system, /REGLES-DE-MOCKY/);
  assert.match(premier.system, /LAYOUT MODEL — code du modèle/);
  assert.match(premier.system, /Fond blanc lumineux/);
  assert.match(premier.system, /PARS DE CE CODE/);
  assert.deepEqual(premier.messages, [{ role: 'user', content: 'DEMANDE-DU-POST' }]);
  // L'erreur de rendu revient avec le code précédent : corriger CETTE erreur seulement.
  assert.equal(second.messages.length, 3);
  assert.match(second.messages[2].content, /ReferenceError: Foo is not defined/);

  const envois = appels.filter((a) => a.name === 'submit_screen').map((a) => a.args.code);
  assert.deepEqual(envois, ['export default function App(){ return <Doc>PREMIER</Doc> }', 'export default function App(){ return <Doc>CORRIGE</Doc> }']);
  const post = (await api('GET', `/api/posts/${p.id}`)).json;
  assert.equal(post.mocky.projet, 'p-client');
  assert.equal(post.photos.meta.length, 1);
  await api('PUT', '/api/mocky/reglages', { redacteur: 'mocky', formats: { meta: '' }, consignes: '' });
});

test('un refus de Mocky est rapporté dans la tâche', async () => {
  await api('PUT', '/api/mocky/reglages', { cle: 'mocky_ak_mauvaise' });
  const p = (await api('POST', '/api/posts', { titre: 'Refus', datePublication: '2030-10-20', plateformes: ['LinkedIn'] })).json;
  assert.equal((await api('POST', `/api/posts/${p.id}/mocky`, { visuel: 'meta' })).status, 400, 'pas prévu sur Instagram');
  const t = await finDeTache((await api('POST', `/api/posts/${p.id}/mocky`, { visuel: 'linkedin' })).json.id);
  assert.equal(t.etat, 'echec');
  assert.match(t.message, /clé/);
  await api('PUT', '/api/mocky/reglages', { cle: CLE });
});
