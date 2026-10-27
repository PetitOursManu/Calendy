#!/usr/bin/env node
'use strict';
/**
 * Connecteur MCP de Calendy : permet à Claude Desktop de piloter le calendrier.
 *
 * C'est un pont : il parle MCP (stdio) à Claude Desktop et appelle l'API REST de Calendy,
 * que celle-ci tourne sur ce poste ou sur un serveur distant.
 *
 * Variables d'environnement :
 *   CALENDY_URL         adresse de Calendy (défaut http://127.0.0.1:3000)
 *   CALENDY_TOKEN       jeton d'accès, si le serveur en exige un
 *   CALENDY_EXPORT_DIR  dossier où enregistrer les fichiers Excel (défaut : Téléchargements)
 *
 * Attention : sur stdout ne circule que du protocole MCP. Tout message de diagnostic va sur stderr.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE_URL = (process.env.CALENDY_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
// Espaces et guillemets en trop retirés, comme côté serveur (un retour à la ligne rendrait l'en-tête invalide).
const TOKEN = (process.env.CALENDY_TOKEN || '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();

/* ------------------------------------------------------------------ */
/* Appels à l'API                                                     */
/* ------------------------------------------------------------------ */

async function call(method, route, body, { raw = false } = {}) {
  const headers = {};
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE_URL + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(
      `Calendy est injoignable à l'adresse ${BASE_URL} (${err.cause?.code || err.message}). ` +
        'Vérifie que le serveur tourne et que CALENDY_URL est correct.',
    );
  }
  if (res.status === 401) throw new Error('Jeton refusé : vérifie CALENDY_TOKEN dans la configuration du connecteur.');
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* réponse non JSON */
  }
  if (!res.ok) throw new Error((data && data.error) || `Erreur ${res.status} de Calendy.`);
  return data;
}

const query = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err.message);
  }
};

/* ------------------------------------------------------------------ */
/* Schémas                                                            */
/* ------------------------------------------------------------------ */

const STATUTS = ['idee', 'valide', 'refuse', 'publie'];
const RESEAUX = ['Instagram', 'Facebook', 'LinkedIn'];
const dateSchema = (label) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format AAAA-MM-JJ').describe(label);

const champsPost = {
  titre: z.string().min(1).max(200).describe('Titre court du post (il sert à le repérer dans le calendrier).'),
  datePublication: dateSchema('Date de publication, au format AAAA-MM-JJ.'),
  plateformes: z.array(z.enum(RESEAUX)).min(1).describe('Réseaux visés : Instagram, Facebook, LinkedIn.'),
  heure: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'format HH:MM').optional().describe('Heure de publication conseillée, au format HH:MM.'),
  description: z.string().max(5000).optional().describe('Légende du post, prête à publier (avec ses emojis éventuels), sans les hashtags.'),
  hashtags: z.union([z.string(), z.array(z.string())]).optional().describe('Hashtags, séparés par des espaces (ex. "#ESAT #Handicap").'),
  imageIdee: z.string().max(1000).optional().describe("Idée d'image ou de photo à prévoir, décrite en une phrase."),
  eventId: z.string().nullable().optional().describe("Identifiant de l'événement lié (voir lister_evenements). null pour détacher."),
  atelier: z.string().max(200).optional().describe('Atelier ou thème : Cuisine, Service en salle, Espaces verts, Industrie, Logistique, Encadrants, Transversal…'),
  angle: z.string().max(1000).optional().describe('Angle éditorial du post, en une phrase.'),
  vigilance: z.string().max(2000).optional().describe("Point de vigilance à vérifier avant publication (droit à l'image, sujet sensible, accord d'une entreprise partenaire…)."),
};

/* ------------------------------------------------------------------ */
/* Serveur MCP                                                        */
/* ------------------------------------------------------------------ */

const INSTRUCTIONS = `Calendy est le calendrier éditorial des réseaux sociaux de l'ESAT Elisa 30 (restaurant Chez Elisa30, ateliers cuisine, service en salle, espaces verts, industrie, logistique).
Tu proposes des idées de posts ; c'est l'utilisateur qui décide lesquels sont retenus.
- Commence par apercu pour voir l'état du calendrier, puis lister_evenements avant d'en créer un (évite les doublons).
- Rattache chaque post à son événement (eventId) quand il y en a un ; sinon laisse vide (contenu « coulisses »).
- Crée toujours les posts avec le statut « idee » (c'est le défaut). Ne passe un post à « valide » ou « refuse » que si l'utilisateur le demande explicitement.
- description = légende prête à publier, sans hashtags ; hashtags à part ; imageIdee = description de la photo à prévoir (pas d'image réelle).
- Sujets sensibles (santé mentale, handicap psychique) : message centré sur le travail et la fierté collective, jamais de diagnostic ni de personne identifiable, et mets un point de vigilance qui demande une validation avant publication. Ne nomme pas une entreprise partenaire sans son accord.`;

const server = new McpServer({ name: 'calendy', version: '1.0.0' }, { instructions: INSTRUCTIONS });

const lecture = { readOnlyHint: true, openWorldHint: false };
const ecriture = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function resumePost(p, evenements) {
  const ev = p.eventId ? evenements.find((e) => e.id === p.eventId) : null;
  return {
    id: p.id,
    date: p.datePublication,
    heure: p.heure || null,
    titre: p.titre,
    reseaux: p.plateformes,
    statut: p.statut,
    evenement: ev ? ev.nom : null,
  };
}

server.registerTool(
  'apercu',
  {
    title: 'Aperçu du calendrier',
    description:
      "État général du calendrier : nombre de posts par statut, posts en attente de validation, prochains posts validés, événements à venir qui n'ont encore aucun post. À appeler en premier.",
    inputSchema: {},
    annotations: lecture,
  },
  safe(async () => {
    const { posts, evenements } = await call('GET', '/api/state');
    const today = new Date().toISOString().slice(0, 10);
    const parStatut = Object.fromEntries(STATUTS.map((s) => [s, posts.filter((p) => p.statut === s).length]));
    return ok({
      aujourdhui: today,
      totalPosts: posts.length,
      parStatut,
      aValider: posts.filter((p) => p.statut === 'idee').map((p) => resumePost(p, evenements)),
      prochainsPostsValides: posts
        .filter((p) => p.statut === 'valide' && p.datePublication >= today)
        .slice(0, 8)
        .map((p) => resumePost(p, evenements)),
      evenementsAVenirSansPost: evenements
        .filter((e) => e.dateFin >= today && !posts.some((p) => p.eventId === e.id))
        .map((e) => ({ id: e.id, nom: e.nom, du: e.dateDebut, au: e.dateFin })),
    });
  }),
);

server.registerTool(
  'lister_posts',
  {
    title: 'Lister les posts',
    description:
      'Liste les posts du calendrier, triés par date. Filtres facultatifs : statuts, période, mot à chercher. Renvoie un résumé par post ; utilise lire_post pour le texte complet.',
    inputSchema: {
      statuts: z.array(z.enum(STATUTS)).optional().describe('idee = à valider, valide, refuse, publie. Par défaut : tous.'),
      du: dateSchema('Date de publication minimale (incluse).').optional(),
      au: dateSchema('Date de publication maximale (incluse).').optional(),
      recherche: z.string().optional().describe('Mot ou expression à chercher dans les textes du post.'),
      detail: z.boolean().optional().describe('true pour renvoyer les posts complets (légende, hashtags…) au lieu du résumé.'),
    },
    annotations: lecture,
  },
  safe(async ({ statuts, du, au, recherche, detail }) => {
    const [posts, evenements] = await Promise.all([
      call('GET', `/api/posts${query({ statut: statuts && statuts.join(','), du, au, q: recherche })}`),
      call('GET', '/api/evenements'),
    ]);
    return ok({ nombre: posts.length, posts: detail ? posts : posts.map((p) => resumePost(p, evenements)) });
  }),
);

server.registerTool(
  'lire_post',
  {
    title: 'Lire un post',
    description: "Renvoie toutes les informations d'un post (légende, hashtags, idée d'image, vigilance) avec l'événement lié et son explication.",
    inputSchema: { id: z.string().describe('Identifiant du post (voir lister_posts).') },
    annotations: lecture,
  },
  safe(async ({ id }) => ok(await call('GET', `/api/posts/${encodeURIComponent(id)}`))),
);

server.registerTool(
  'creer_post',
  {
    title: 'Créer un post',
    description:
      "Ajoute un post au calendrier. Sans statut précisé, il est créé « idee » : une idée que l'utilisateur validera ou refusera. Ne le valide pas de ta propre initiative.",
    inputSchema: { ...champsPost, statut: z.enum(STATUTS).optional().describe('Par défaut idee (à valider).') },
    annotations: ecriture,
  },
  safe(async (args) => ok(await call('POST', '/api/posts', args))),
);

server.registerTool(
  'modifier_post',
  {
    title: 'Modifier un post',
    description: "Modifie un post existant : seuls les champs fournis changent. Pour changer uniquement le statut, préfère changer_statut.",
    inputSchema: {
      id: z.string().describe('Identifiant du post.'),
      ...Object.fromEntries(Object.entries(champsPost).map(([k, v]) => [k, v.optional()])),
      statut: z.enum(STATUTS).optional(),
    },
    annotations: { ...ecriture, idempotentHint: true },
  },
  safe(async ({ id, ...champs }) => ok(await call('PUT', `/api/posts/${encodeURIComponent(id)}`, champs))),
);

server.registerTool(
  'changer_statut',
  {
    title: 'Changer le statut de posts',
    description:
      "Valide, refuse, publie ou remet « à valider » un ou plusieurs posts. À n'utiliser que sur demande explicite de l'utilisateur (« valide celui-ci », « refuse les deux Halloween »…).",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe('Identifiants des posts.'),
      statut: z.enum(STATUTS).describe('idee = à valider, valide, refuse, publie.'),
    },
    annotations: { ...ecriture, idempotentHint: true },
  },
  safe(async ({ ids, statut }) => ok(await call('POST', '/api/posts/statut', { ids, statut }))),
);

server.registerTool(
  'supprimer_post',
  {
    title: 'Supprimer un post',
    description: "Supprime définitivement un post. À n'utiliser que si l'utilisateur le demande ; pour écarter une idée, préfère le statut « refuse ».",
    inputSchema: { id: z.string().describe('Identifiant du post.') },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  safe(async ({ id }) => ok(await call('DELETE', `/api/posts/${encodeURIComponent(id)}`))),
);

server.registerTool(
  'lister_evenements',
  {
    title: 'Lister les événements',
    description:
      "Liste les événements (journées nationales, semaines thématiques, temps forts de l'ESAT…) avec leurs dates, leur explication et leur lien avec Elisa30. À consulter avant d'en créer un.",
    inputSchema: {
      du: dateSchema('Ne garder que les événements qui se terminent à partir de cette date.').optional(),
      au: dateSchema('Ne garder que les événements qui commencent au plus tard à cette date.').optional(),
    },
    annotations: lecture,
  },
  safe(async ({ du, au }) => ok(await call('GET', `/api/evenements${query({ du, au })}`))),
);

const champsEvenement = {
  nom: z.string().min(1).max(200).describe("Nom de l'événement (ex. « Semaine du Goût (37e édition) »)."),
  dateDebut: dateSchema('Premier jour, AAAA-MM-JJ.'),
  dateFin: dateSchema("Dernier jour, AAAA-MM-JJ. Omettre pour un événement d'un seul jour.").optional(),
  explication: z.string().max(3000).optional().describe("Ce qu'il faut savoir sur l'événement (« Ce qu'il faut savoir »)."),
  lienElisa30: z.string().max(2000).optional().describe("Lien avec l'ESAT Elisa 30 : pourquoi et comment s'en saisir."),
};

server.registerTool(
  'creer_evenement',
  {
    title: 'Créer un événement',
    description: "Ajoute un événement au calendrier. Vérifie avec lister_evenements qu'il n'existe pas déjà.",
    inputSchema: champsEvenement,
    annotations: ecriture,
  },
  safe(async (args) => ok(await call('POST', '/api/evenements', args))),
);

server.registerTool(
  'modifier_evenement',
  {
    title: 'Modifier un événement',
    description: 'Modifie un événement existant : seuls les champs fournis changent.',
    inputSchema: {
      id: z.string().describe("Identifiant de l'événement."),
      ...Object.fromEntries(Object.entries(champsEvenement).map(([k, v]) => [k, v.optional()])),
    },
    annotations: { ...ecriture, idempotentHint: true },
  },
  safe(async ({ id, ...champs }) => ok(await call('PUT', `/api/evenements/${encodeURIComponent(id)}`, champs))),
);

server.registerTool(
  'supprimer_evenement',
  {
    title: 'Supprimer un événement',
    description: "Supprime un événement. Les posts qui y étaient liés sont conservés, simplement détachés. À n'utiliser que sur demande de l'utilisateur.",
    inputSchema: { id: z.string().describe("Identifiant de l'événement.") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  safe(async ({ id }) => ok(await call('DELETE', `/api/evenements/${encodeURIComponent(id)}`))),
);

server.registerTool(
  'exporter_excel',
  {
    title: 'Exporter en Excel',
    description:
      "Génère le fichier Excel du calendrier (feuilles « Calendrier éditorial » et « Événements ») et l'enregistre sur cet ordinateur. Par défaut, seuls les posts validés ou publiés sont exportés. Renvoie le chemin du fichier.",
    inputSchema: {
      statuts: z.array(z.enum(STATUTS)).optional().describe('Statuts à inclure. Par défaut : valide et publie.'),
      du: dateSchema('Date de publication minimale (incluse).').optional(),
      au: dateSchema('Date de publication maximale (incluse).').optional(),
      dossier: z.string().optional().describe('Dossier de destination. Par défaut : le dossier Téléchargements.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  safe(async ({ statuts, du, au, dossier }) => {
    const res = await call('GET', `/api/export.xlsx${query({ statuts: statuts && statuts.join(','), du, au })}`, undefined, { raw: true });
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/);
    const nom = m ? decodeURIComponent(m[1]) : 'Calendrier_editorial_Elisa30.xlsx';
    const dir = path.resolve(dossier || process.env.CALENDY_EXPORT_DIR || path.join(os.homedir(), 'Downloads'));
    fs.mkdirSync(dir, { recursive: true });
    let cible = path.join(dir, nom);
    for (let i = 2; fs.existsSync(cible); i += 1) cible = path.join(dir, nom.replace(/\.xlsx$/, `_${i}.xlsx`));
    fs.writeFileSync(cible, Buffer.from(await res.arrayBuffer()));
    return ok({ fichier: cible, posts: Number(res.headers.get('x-calendy-posts')) });
  }),
);

/* ------------------------------------------------------------------ */

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`Connecteur Calendy prêt (serveur : ${BASE_URL})`);
}

main().catch((err) => {
  console.error('Échec du démarrage du connecteur Calendy :', err);
  process.exit(1);
});
