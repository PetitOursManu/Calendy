'use strict';
/**
 * Visuels Mocky : Calendy demande à Mocky (son serveur MCP, avec une clé d'assistant) le visuel d'un post,
 * puis range le PNG dans les images du post et le fichier Canva (.pptx, « tout en éléments séparés ») à côté.
 *
 * - Un projet Mocky par post : le premier visuel crée le projet, à partir du modèle choisi (create_design avec
 *   template_id) ; le second visuel du même post (l'autre réseau) est ajouté dans ce même projet (add_screen).
 * - Le modèle se choisit par événement, puis par thème (l'atelier du post), puis le modèle par défaut.
 * - Une modification demandée passe par edit_design (Mocky garde la version précédente) ; « Mettre à jour l'image du post »
 *   ré-exporte simplement l'écran, pour récupérer une retouche faite à la main dans Mocky.
 *
 * Une génération prend de 30 secondes à plusieurs minutes : chaque demande devient une « tâche » suivie par
 * l'interface (GET /api/mocky/taches). Mocky ne fait qu'un design à la fois par compte : Calendy aussi.
 *
 * Réglages dans DATA_DIR/mocky.json (fichier séparé de data.json, mode 600). MOCKY_URL et MOCKY_API_KEY,
 * si elles existent, ont la priorité sur ce qui est saisi dans l'interface. La clé n'est jamais renvoyée au navigateur.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VISUELS = {
  meta: { libelle: 'Instagram et Facebook', ecran: 'instagram', court: 'Insta-Facebook' },
  linkedin: { libelle: 'LinkedIn', ecran: 'linkedin', court: 'LinkedIn' },
};
const ATTENTE_MAX = 20 * 60 * 1000; // une génération avec Muse peut être longue ; au-delà, on abandonne
const TELECHARGEMENT_MAX = 40 * 1024 * 1024;
const TACHES_GARDEES = 30;
const MODELE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Délais côté Calendy. Sans eux, un Mocky injoignable laissait la requête du navigateur ouverte jusqu'à ce que le
 * proxy placé devant Calendy coupe et renvoie SA page d'erreur HTML : l'interface affichait alors
 * « Unexpected token '<' » au lieu de la vraie raison. Ils restent bien en dessous des délais habituels d'un proxy (60 s).
 */
const DELAI_CONNEXION = 15000;
const DELAI_LECTURE = 20000;
const DELAI_TRAVAIL = 120000;
/**
 * Le code des erreurs venues de Mocky : 424 (« dépendance en échec »), jamais 502 ni 504. Un proxy placé devant
 * Calendy (Traefik, Cloudflare…) remplace une réponse 502 ou 504 par SA page d'erreur HTML, et le message qui
 * expliquait le problème n'arrivait jamais à l'écran.
 */
const ERREUR_SERVICE = 424;

/** Pour comparer deux thèmes sans tenir compte des majuscules, des accents ni des espaces. */
const cleTheme = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Les formats d'image que Mocky sait faire pour un post (son `page_format`). Vide : celui du type d'écran. */
const FORMATS = {
  'social-square': 'Carré 1:1 (1080 × 1080)',
  'social-portrait': 'Portrait 4:5 (1080 × 1350)',
  'social-story': 'Story 9:16 (1080 × 1920)',
  'social-landscape': 'Paysage 1,91:1 (1200 × 628)',
};
const REDACTEURS = ['mocky', 'calendy'];
const CONSIGNES_MAX = 3000;

/**
 * Quand Calendy écrit lui-même le code (réglage « L'agent IA de Calendy ») : la consigne qui fait de lui un copiste
 * du modèle, comme le fait Claude Desktop avec la compétence Elisa30. Les règles de Mocky contiennent alors le code
 * complet du modèle (LAYOUT MODEL) ; le recopier en ne changeant que le contenu est ce qui garde le visuel fidèle.
 */
const CONSIGNE_COPIE = `Tu écris pour Calendy le composant d'un visuel de réseau social, en suivant les règles de Mocky ci-dessus.
Si ces règles contiennent un LAYOUT MODEL (le code d'un modèle choisi par l'utilisateur), PARS DE CE CODE : recopie-le et ne change que le contenu propre à ce post (titres, accroche, liste, textes, photo). Garde à l'identique la structure, les classes, les couleurs, les polices, les tailles et les blocs fixes (coordonnées, contact, emplacement du logo). Vérifie qu'aucun texte de l'ancien sujet ne reste.
Réponds uniquement par le composant complet, sans explication.`;

/** Les deux parties de ce que Mocky donne à écrire (submit_screen) : ses règles et la demande. */
function decouperContrat(texte) {
  const t = String(texte || '');
  const regles = t.search(/^## (RÈGLES|RULES)\b.*$/m);
  const demande = Math.max(t.lastIndexOf('\n## DEMANDE'), t.lastIndexOf('\n## REQUEST'));
  if (regles < 0 || demande < regles) return null;
  const finTitre = t.indexOf('\n', regles);
  const debutDemande = t.indexOf('\n', demande + 1);
  return { regles: t.slice(finTitre + 1, demande).trim(), demande: t.slice(debutDemande + 1).trim() };
}

function creerMocky({ dataDir, HttpError, lirePost, nomEvenement, appliquer, nomStructure, ecrireCode = null, client: clientInjecte }) {
  const FICHIER = path.join(dataDir, 'mocky.json');
  const taches = new Map();
  let modelesCache = null;

  /* ------------------------------ réglages ------------------------------ */

  const defauts = () => ({ url: '', cle: '', modeleDefaut: '', themes: [], evenements: {}, formats: { meta: '', linkedin: '' }, redacteur: 'mocky', consignes: '' });

  function lire() {
    try {
      const f = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
      return { ...defauts(), ...f, formats: { ...defauts().formats, ...(f.formats || {}) }, themes: Array.isArray(f.themes) ? f.themes : [], evenements: f.evenements && typeof f.evenements === 'object' ? f.evenements : {} };
    } catch {
      return defauts();
    }
  }

  function ecrire(r) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${FICHIER}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, FICHIER);
  }

  const urlEnv = () => String(process.env.MOCKY_URL || '').trim();
  const cleEnv = () => String(process.env.MOCKY_API_KEY || '').trim();

  function connexion(r = lire()) {
    const brut = urlEnv() || r.url;
    const cle = cleEnv() || r.cle;
    if (!brut || !cle) return null;
    // L'adresse donnée peut être celle de Mocky ou directement celle de son point MCP.
    const base = brut.replace(/\/+$/, '').replace(/\/mcp$/, '');
    return { base, mcp: `${base}/mcp`, cle };
  }

  /** Ce que le navigateur peut voir : jamais la clé. */
  function publics(r = lire()) {
    const { cle, ...reste } = r;
    return {
      ...reste,
      url: urlEnv() || r.url,
      urlSource: urlEnv() ? 'env' : r.url ? 'reglages' : null,
      cle: { definie: Boolean(cleEnv() || cle), source: cleEnv() ? 'env' : cle ? 'reglages' : null, variable: 'MOCKY_API_KEY' },
      pret: Boolean(connexion(r)),
    };
  }

  function modifier(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Corps JSON attendu.');
    const r = lire();
    if ('url' in body) {
      const url = String(body.url ?? '').trim();
      if (url) {
        let u;
        try { u = new URL(url); } catch { throw new HttpError(400, 'Adresse de Mocky invalide.'); }
        if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'L’adresse de Mocky doit commencer par https://.');
      }
      r.url = url.slice(0, 300);
    }
    if ('cle' in body) {
      const cle = body.cle === null ? '' : String(body.cle).trim();
      if (cle.length > 300 || /\s/.test(cle)) throw new HttpError(400, 'Clé Mocky invalide.');
      if (cle && !cle.startsWith('mocky_ak_')) throw new HttpError(400, 'Une clé d’assistant Mocky commence par « mocky_ak_ ».');
      r.cle = cle;
    }
    if ('modeleDefaut' in body) r.modeleDefaut = modeleOuVide(body.modeleDefaut);
    if ('formats' in body) {
      if (!body.formats || typeof body.formats !== 'object') throw new HttpError(400, 'Champ « formats » : { meta, linkedin }.');
      for (const v of Object.keys(VISUELS)) {
        if (!(v in body.formats)) continue;
        const f = String(body.formats[v] || '');
        if (f && !FORMATS[f]) throw new HttpError(400, `Format inconnu : ${f.slice(0, 40)}`);
        r.formats[v] = f;
      }
    }
    if ('redacteur' in body) {
      if (!REDACTEURS.includes(body.redacteur)) throw new HttpError(400, 'Champ « redacteur » : mocky ou calendy.');
      r.redacteur = body.redacteur;
    }
    if ('consignes' in body) {
      if (typeof body.consignes !== 'string' || body.consignes.length > CONSIGNES_MAX) throw new HttpError(400, `Les consignes visuelles sont limitées à ${CONSIGNES_MAX.toLocaleString('fr-FR')} caractères.`);
      r.consignes = body.consignes.trim();
    }
    if ('themes' in body) {
      if (!Array.isArray(body.themes) || body.themes.length > 100) throw new HttpError(400, 'Champ « themes » : une liste de 100 règles au plus.');
      const vus = new Set();
      r.themes = [];
      for (const t of body.themes) {
        const theme = String((t && t.theme) || '').trim().slice(0, 200);
        const modele = modeleOuVide(t && t.modele);
        if (!theme || !modele || vus.has(cleTheme(theme))) continue;
        vus.add(cleTheme(theme));
        r.themes.push({ theme, modele });
      }
    }
    if ('evenements' in body) {
      if (!body.evenements || typeof body.evenements !== 'object' || Array.isArray(body.evenements)) throw new HttpError(400, 'Champ « evenements » : un objet { identifiant: modèle }.');
      r.evenements = {};
      for (const [id, m] of Object.entries(body.evenements).slice(0, 500)) {
        const modele = modeleOuVide(m);
        if (/^[\w-]{1,64}$/.test(id) && modele) r.evenements[id] = modele;
      }
    }
    ecrire(r);
    modelesCache = null;
    return publics(r);
  }

  function modeleOuVide(v) {
    const m = String(v ?? '').trim();
    if (m && !MODELE_RE.test(m)) throw new HttpError(400, `Identifiant de modèle invalide : ${m.slice(0, 40)}`);
    return m;
  }

  /** Le modèle d'un post : celui de son événement, sinon celui de son thème, sinon le modèle par défaut. */
  function modelePour(post, r = lire()) {
    if (post.eventId && r.evenements[post.eventId]) return { modele: r.evenements[post.eventId], raison: 'evenement' };
    const theme = cleTheme(post.atelier);
    const regle = theme && r.themes.find((t) => cleTheme(t.theme) === theme);
    if (regle) return { modele: regle.modele, raison: 'theme' };
    if (r.modeleDefaut) return { modele: r.modeleDefaut, raison: 'defaut' };
    return { modele: '', raison: 'aucun' };
  }

  /* ------------------------------ client MCP ------------------------------ */

  function erreurMocky(err) {
    if (err instanceof HttpError) return err;
    const m = String((err && err.message) || err || '');
    if ((err && err.code === -32001) || /timed? ?out|délai/i.test(m)) {
      return new HttpError(ERREUR_SERVICE, 'Mocky ne répond pas au serveur de Calendy (délai dépassé). Vérifie que le serveur de Calendy peut joindre cette adresse ; si Calendy et Mocky tournent sur la même machine (Docker, Coolify), essaie l’adresse interne de Mocky, par exemple http://mocky:8787.');
    }
    if (/401|403|invalid_token|Unauthorized/i.test(m)) return new HttpError(ERREUR_SERVICE, 'Mocky refuse la clé : vérifie la clé d’assistant (lecture + écriture) dans Réglages, onglet Mocky.');
    if (/404/.test(m)) return new HttpError(ERREUR_SERVICE, 'Mocky ne répond pas à cette adresse : vérifie l’adresse, et que l’administrateur de Mocky a activé les assistants (MCP).');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|certificate|abort/i.test(m)) return new HttpError(ERREUR_SERVICE, `Le serveur de Calendy n’arrive pas à joindre Mocky à cette adresse (${m.slice(0, 120)}). Si Calendy et Mocky tournent sur la même machine, essaie l’adresse interne de Mocky.`);
    if (/content type|Unexpected token|not valid JSON/i.test(m)) return new HttpError(ERREUR_SERVICE, 'À cette adresse, ce n’est pas le serveur MCP de Mocky qui répond (une page web à la place). Vérifie l’adresse, et que l’administrateur de Mocky a activé les assistants (MCP).');
    return new HttpError(ERREUR_SERVICE, `Mocky a répondu par une erreur : ${m.slice(0, 200)}`);
  }

  /** Une connexion MCP le temps d'une série d'appels. Mocky est sans état : rien n'est gardé entre deux séries. */
  async function avecClient(fn) {
    const c = connexion();
    if (!c) throw new HttpError(400, 'Mocky n’est pas configuré : renseigne son adresse et une clé d’assistant dans Réglages, onglet Mocky.');
    if (clientInjecte) return fn(clientInjecte(c));
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'calendy', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(c.mcp), { requestInit: { headers: { Authorization: `Bearer ${c.cle}` } } });
    try {
      await client.connect(transport, { timeout: DELAI_CONNEXION });
    } catch (err) {
      await client.close().catch(() => {});
      throw erreurMocky(err);
    }
    try {
      return await fn({
        async outil(name, args, delai = DELAI_TRAVAIL) {
          let r;
          try {
            // Mocky attend lui-même une quarantaine de secondes avant de rendre la main : on lui en laisse le temps.
            r = await client.callTool({ name, arguments: args }, undefined, { timeout: delai });
          } catch (err) {
            throw erreurMocky(err);
          }
          const texte = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          if (r.isError) {
            if (/moteur « client »|"client" engine/.test(texte)) {
              throw new HttpError(ERREUR_SERVICE, 'Mocky n’autorise pas l’assistant à écrire le code. Dans Mocky : Admin → Assistants (MCP) → « Qui écrit le code d’un design », choisis « au choix » ou « le modèle de l’assistant ». Sinon, dans Calendy, Réglages → Mocky, choisis « Mocky » pour écrire le visuel.');
            }
            throw new HttpError(ERREUR_SERVICE, `Mocky : ${texte.slice(0, 400) || 'refus sans explication.'}`);
          }
          return { ...(r.structuredContent || {}), texte };
        },
        async outils() {
          try {
            return (await client.listTools(undefined, { timeout: DELAI_LECTURE })).tools.map((t) => t.name);
          } catch (err) {
            throw erreurMocky(err);
          }
        },
        base: c.base,
      });
    } finally {
      await client.close().catch(() => {});
    }
  }

  /**
   * Mocky signe ses liens avec SON adresse publique ; le serveur de Calendy, lui, joint Mocky à l'adresse des
   * réglages, qui peut être une adresse interne. Le lien est donc ramené à cette adresse (la signature ne porte
   * que sur le chemin et ses paramètres).
   */
  function versBase(url, base) {
    try {
      const u = new URL(url);
      if (!/^\/mcp-export\//.test(u.pathname)) return url;
      return `${new URL(base).origin}${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  }

  async function telecharger(url, attendu) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(DELAI_TRAVAIL) });
    } catch (err) {
      throw erreurMocky(err);
    }
    if (!res.ok) throw new HttpError(ERREUR_SERVICE, `Le fichier ${attendu} n’a pas pu être téléchargé depuis Mocky (${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > TELECHARGEMENT_MAX) throw new HttpError(ERREUR_SERVICE, `Le fichier ${attendu} reçu de Mocky est vide ou trop lourd.`);
    return buf;
  }

  /** Les modèles de projet du compte Mocky (gardés une minute : la page des réglages les demande souvent). */
  async function listerModeles({ frais = false } = {}) {
    if (!frais && modelesCache && modelesCache.expire > Date.now()) return modelesCache.liste;
    const out = await avecClient((m) => m.outil('list_templates', {}, DELAI_LECTURE));
    const liste = (out.templates || []).map((t) => ({ id: String(t.id), nom: String(t.name || t.id), ecrans: t.screens || 0 }));
    modelesCache = { liste, expire: Date.now() + 60000 };
    return liste;
  }

  /** Les outils sans lesquels Calendy ne peut rien faire : absents, c'est que ce Mocky tourne sur une version antérieure. */
  const OUTILS_REQUIS = ['list_templates', 'create_design', 'add_screen', 'get_design', 'edit_design', 'export_screen'];

  async function tester() {
    const offerts = await avecClient((m) => m.outils());
    const manquants = OUTILS_REQUIS.filter((n) => !offerts.includes(n));
    if (manquants.length) {
      const ecriture = ['create_design', 'add_screen', 'edit_design'].every((n) => manquants.includes(n)) && !manquants.includes('get_design');
      throw new HttpError(ERREUR_SERVICE, ecriture && !manquants.includes('list_templates')
        ? 'La clé Mocky est en « Lecture seule » : crée une clé « Lecture + écriture » dans Mocky (Réglages → Assistants connectés).'
        : `Connexion réussie, mais ce Mocky ne propose pas : ${manquants.join(', ')}. Il tourne sur une version antérieure aux exports et aux modèles (pull request « MCP : export PNG / PPTX Canva et nouveau projet depuis un modèle »). Dans Coolify, relance un déploiement depuis la branche main qui RECONSTRUIT l’image (pas un simple redémarrage). Outils proposés aujourd’hui : ${offerts.join(', ') || 'aucun'}.`);
    }
    if (lire().redacteur === 'calendy' && !offerts.includes('submit_screen')) {
      throw new HttpError(ERREUR_SERVICE, 'Connexion réussie, mais ce Mocky ne laisse pas l’assistant écrire le code, et Calendy est réglé pour l’écrire. Dans Mocky : Admin → Assistants (MCP) → « Qui écrit le code d’un design », choisis « au choix » ou « le modèle de l’assistant ». Ou choisis ici « Mocky » pour écrire le visuel.');
    }
    const liste = await listerModeles({ frais: true });
    return { ok: true, message: liste.length ? `Connexion réussie : ${liste.length} modèle${liste.length > 1 ? 's' : ''} de projet dans ce compte Mocky.` : 'Connexion réussie, mais ce compte Mocky n’a encore aucun modèle de projet (dans Mocky : Exporter → Enregistrer comme modèle).', modeles: liste };
  }

  /* ------------------------------ tâches ------------------------------ */

  const vueTache = (t) => ({ id: t.id, postId: t.postId, visuel: t.visuel, action: t.action, etat: t.etat, etape: t.etape, message: t.message, debut: t.debut, fin: t.fin || null });

  function listerTaches() {
    return [...taches.values()].sort((a, b) => b.debut - a.debut).map(vueTache);
  }

  function lireTache(id) {
    const t = taches.get(String(id));
    if (!t) throw new HttpError(404, 'Tâche inconnue (le serveur a peut-être redémarré).');
    return vueTache(t);
  }

  /** Le texte que Mocky lit comme le CONTENU du visuel (pas une consigne). */
  function briefDe(post, visuel) {
    const ev = post.eventId ? nomEvenement(post.eventId) : '';
    const legende = String(post.description || '').replace(/\s+\n/g, '\n').trim();
    const parties = [
      `Visuel du post ${VISUELS[visuel].libelle} « ${post.titre} »${nomStructure() ? `, pour ${nomStructure()}` : ''}.`,
      `Publication le ${post.datePublication}${post.heure ? ` à ${post.heure.replace(':', 'h')}` : ''}.`,
      ev ? `Événement : ${ev}.` : '',
      post.angle ? `Angle : ${post.angle}` : '',
      legende ? `Texte du post (le visuel en reprend l’essentiel, pas tout) :\n${legende.slice(0, 1800)}` : '',
      post.imageIdee ? `Idée d’image : ${post.imageIdee}` : '',
    ];
    return parties.filter(Boolean).join('\n').slice(0, 3900);
  }

  /** Attend la fin d'un travail Mocky : chaque appel à get_design attend lui-même une quarantaine de secondes. */
  /**
   * Quand Mocky attend le code (moteur « client ») : l'agent de Calendy l'écrit à partir des règles de Mocky, des
   * consignes visuelles et de la consigne de copie, puis le renvoie. Une erreur de rendu revient corriger CETTE erreur.
   */
  function ecrivain(r0) {
    const reglages = lire();
    const historique = [];
    let contrat = null;
    return async (r) => {
      if (!ecrireCode) throw new HttpError(ERREUR_SERVICE, 'L’agent IA de Calendy n’est pas disponible pour écrire le visuel.');
      if (!contrat) {
        contrat = decouperContrat(r.texte || r0.texte);
        if (!contrat) throw new HttpError(ERREUR_SERVICE, 'Mocky a demandé le code sans donner ses règles : réessaie.');
        historique.push({ role: 'user', content: contrat.demande });
      } else {
        historique.push({ role: 'user', content: `Le code envoyé ne s'affiche pas. Erreur de rendu :\n${String(r.renderError || r.texte || '').slice(0, 2000)}\n\nCorrige CETTE erreur seulement, sans rien changer d'autre, et renvoie le composant complet.` });
      }
      const systeme = [contrat.regles, reglages.consignes ? `CONSIGNES VISUELLES DE L'UTILISATEUR (à respecter) :\n${reglages.consignes}` : '', CONSIGNE_COPIE].filter(Boolean).join('\n\n');
      const code = await ecrireCode({ systeme, messages: historique });
      if (!code.trim()) throw new HttpError(ERREUR_SERVICE, 'L’agent IA n’a pas écrit de code pour ce visuel.');
      historique.push({ role: 'assistant', content: code });
      return code.slice(0, 300000);
    };
  }

  async function attendre(m, reponse, tache) {
    const limite = Date.now() + ATTENTE_MAX;
    let r = reponse;
    let ecrire = null;
    while (r.status !== 'done') {
      if (r.status === 'awaiting_code' && lire().redacteur === 'calendy') {
        ecrire = ecrire || ecrivain(r);
        tache.etape = 'L’agent IA écrit le visuel';
        const code = await ecrire(r);
        tache.etape = 'Mocky vérifie le code';
        r = await m.outil('submit_screen', { job_id: r.jobId, code });
        continue;
      }
      if (r.status === 'failed') throw new HttpError(ERREUR_SERVICE, `Mocky n’a pas pu faire le visuel : ${String(r.error || r.texte || '').slice(0, 300)}`);
      if (r.status === 'needs_clarification') throw new HttpError(ERREUR_SERVICE, 'Mocky demande plus de précisions : complète la description, l’angle ou l’idée d’image du post, puis réessaie.');
      if (r.status === 'awaiting_code') throw new HttpError(ERREUR_SERVICE, 'Ce compte Mocky fait écrire le code par l’assistant : dans Mocky, Réglages → Assistants connectés, choisis « Le modèle de Mocky ».');
      if (!r.jobId) throw new HttpError(ERREUR_SERVICE, `Réponse inattendue de Mocky : ${String(r.texte || '').slice(0, 200)}`);
      if (Date.now() > limite) throw new HttpError(ERREUR_SERVICE, 'Mocky met trop de temps : le visuel sera peut-être dans Mocky plus tard ; utilise alors « Mettre à jour l’image du post ».');
      tache.etape = r.progress ? `Mocky travaille (${String(r.progress).slice(0, 40)})` : 'Mocky travaille';
      r = await m.outil('get_design', { job_id: r.jobId });
    }
    if (!r.projectId || !r.screenId) throw new HttpError(ERREUR_SERVICE, 'Mocky n’a pas dit quel écran il a fait.');
    return r;
  }

  async function exporter(m, projectId, screenId, tache) {
    tache.etape = 'Export du PNG';
    const png = await m.outil('export_screen', { project_id: projectId, screen_id: screenId, format: 'png' });
    if (!png.download) throw new HttpError(ERREUR_SERVICE, 'Mocky n’a pas donné de lien vers le PNG.');
    if (!/\.png$/i.test(png.filename || '')) throw new HttpError(ERREUR_SERVICE, 'Ce visuel a plusieurs pages : Calendy ne garde qu’une image par visuel Mocky pour l’instant.');
    const pngOctets = await telecharger(versBase(png.download, m.base), 'PNG');
    tache.etape = 'Export du fichier Canva';
    const pptx = await m.outil('export_screen', { project_id: projectId, screen_id: screenId, format: 'pptx-edit' });
    if (!pptx.download) throw new HttpError(ERREUR_SERVICE, 'Mocky n’a pas donné de lien vers le fichier Canva.');
    const pptxOctets = await telecharger(versBase(pptx.download, m.base), 'Canva (.pptx)');
    return { png: pngOctets, pptx: pptxOctets, nomCanva: String(pptx.filename || 'visuel - Canva.pptx').slice(0, 160) };
  }

  async function executer(tache, demande) {
    const { postId, visuel, action } = tache;
    await avecClient(async (m) => {
      const post = lirePost(postId);
      const existant = post.mocky && post.mocky.visuels && post.mocky.visuels[visuel];
      let projectId;
      let screenId;
      let lien;
      let modele = (post.mocky && post.mocky.modele) || '';
      if (action === 'creer') {
        const choix = demande.modele !== undefined ? { modele: demande.modele } : modelePour(post);
        modele = choix.modele;
        const reglages = lire();
        const commun = {
          brief: briefDe(post, visuel),
          screen_type: VISUELS[visuel].ecran,
          screen_name: `${post.titre} · ${VISUELS[visuel].court}`.slice(0, 80),
          kind: `Post ${VISUELS[visuel].libelle}`,
          audience: nomStructure() ? `Les abonnés de ${nomStructure()}` : undefined,
          // « client » : Mocky prépare tout et c'est l'agent de Calendy qui écrit le code (voir ecrivain).
          engine: reglages.redacteur === 'calendy' ? 'client' : 'mocky',
          ...(reglages.formats[visuel] ? { page_format: reglages.formats[visuel] } : {}),
          ...(reglages.consignes ? { style: reglages.consignes.slice(0, 300) } : {}),
          ...(post.imageIdee ? { picture_subject: post.imageIdee.slice(0, 300) } : {}),
        };
        let r = null;
        const projet = post.mocky && post.mocky.projet;
        if (projet) {
          // Le projet de ce post existe déjà (l'autre réseau, ou une version précédente) : on y ajoute l'écran.
          tache.etape = 'Ajout de l’écran au projet du post';
          try {
            // follow_layout : même composition que le visuel déjà fait dans ce projet (ou que le modèle).
            r = await m.outil('add_screen', { ...commun, project_id: projet, follow_layout: true });
          } catch (err) {
            if (!/projet|project/i.test(err.message)) throw err;
            r = null; // le projet a été supprimé dans Mocky : on en recrée un
          }
        }
        if (!r) {
          tache.etape = modele ? 'Nouveau projet à partir du modèle' : 'Nouveau projet';
          r = await m.outil('create_design', { ...commun, project_name: `${post.datePublication} · ${post.titre}`.slice(0, 120), ...(modele ? { template_id: modele } : {}) });
        }
        const fini = await attendre(m, r, tache);
        ({ projectId, screenId } = { projectId: fini.projectId, screenId: fini.screenId });
        lien = fini.link;
      } else {
        if (!existant || !post.mocky.projet) throw new HttpError(409, 'Ce visuel n’a pas encore été créé avec Mocky.');
        projectId = post.mocky.projet;
        screenId = existant.ecran;
        lien = existant.lien;
        if (action === 'modifier') {
          tache.etape = 'Modification dans Mocky';
          const r = await m.outil('edit_design', { project_id: projectId, screen_id: screenId, instruction: demande.instruction });
          const fini = await attendre(m, r, tache);
          lien = fini.link || lien;
        }
      }
      const fichiers = await exporter(m, projectId, screenId, tache);
      tache.etape = 'Enregistrement dans Calendy';
      // Les liens montrés à l'utilisateur sont ceux de Mocky (son adresse publique), jamais l'adresse interne des réglages.
      const lienProjet = (lien && lien.replace(/\?.*$/, '')) || (post.mocky && post.mocky.lien) || `${m.base}/p/${encodeURIComponent(projectId)}`;
      appliquer(postId, visuel, { ...fichiers, projet: projectId, ecran: screenId, lien, lienProjet, modele, action });
    });
  }

  /** Lance une tâche et rend la main tout de suite : l'interface suit son avancement. */
  function lancer(postId, body) {
    const b = body && typeof body === 'object' ? body : {};
    const visuel = b.visuel;
    if (!VISUELS[visuel]) throw new HttpError(400, 'Champ « visuel » : meta (Instagram + Facebook) ou linkedin.');
    const action = b.action || 'creer';
    if (!['creer', 'modifier', 'reprendre'].includes(action)) throw new HttpError(400, 'Champ « action » : creer, modifier ou reprendre.');
    const demande = {};
    if (action === 'modifier') {
      demande.instruction = String(b.instruction || '').trim();
      if (!demande.instruction) throw new HttpError(400, 'Dis ce qu’il faut changer dans le visuel.');
      if (demande.instruction.length > 4000) throw new HttpError(400, 'La demande de modification est limitée à 4 000 caractères.');
    }
    if (action === 'creer' && 'modele' in b) demande.modele = modeleOuVide(b.modele);
    if (!connexion()) throw new HttpError(400, 'Mocky n’est pas configuré : renseigne son adresse et une clé d’assistant dans Réglages, onglet Mocky.');
    const post = lirePost(postId);
    const reseaux = visuel === 'meta' ? ['Instagram', 'Facebook'] : ['LinkedIn'];
    if (action === 'creer' && !post.plateformes.some((p) => reseaux.includes(p))) throw new HttpError(400, `Ce post n’est pas prévu sur ${VISUELS[visuel].libelle}.`);
    const enCours = [...taches.values()].find((t) => t.etat === 'en_cours');
    if (enCours) throw new HttpError(409, 'Mocky travaille déjà sur un visuel : attends qu’il ait fini (Mocky fait un design à la fois).');
    const tache = { id: crypto.randomUUID(), postId: post.id, visuel, action, etat: 'en_cours', etape: 'Connexion à Mocky', message: '', debut: Date.now() };
    taches.set(tache.id, tache);
    const anciennes = [...taches.values()].sort((a, b2) => b2.debut - a.debut).slice(TACHES_GARDEES);
    anciennes.forEach((t) => taches.delete(t.id));
    executer(tache, demande).then(
      () => {
        tache.etat = 'fini';
        tache.etape = '';
        tache.message = action === 'modifier' ? 'Visuel modifié dans Mocky et mis à jour.' : action === 'reprendre' ? 'Image du post mise à jour depuis Mocky.' : 'Visuel créé avec Mocky.';
        tache.fin = Date.now();
      },
      (err) => {
        tache.etat = 'echec';
        tache.message = err instanceof HttpError ? err.message : erreurMocky(err).message;
        tache.fin = Date.now();
        if (!(err instanceof HttpError)) console.error('Mocky :', err && err.message);
      },
    );
    return { status: 202, body: vueTache(tache) };
  }

  return { publics, modifier, tester, listerModeles, modelePour: (post) => modelePour(post), lancer, listerTaches, lireTache, VISUELS, FORMATS };
}

module.exports = { creerMocky, cleTheme, decouperContrat };
