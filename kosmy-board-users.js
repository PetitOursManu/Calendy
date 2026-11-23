'use strict';
/**
 * Les utilisateurs gérés par Kosmy Board : protocole kosmy.board-users.v1 (docs/users-api.md du dépôt Kosmy Board).
 *
 * Le serveur du Board appelle trois adresses, avec le même jeton à usage unique que l'admin dans le Board :
 *   GET    /api/kosmy-board/users         les rôles et les restrictions de Calendy, et les comptes Kosmy Board admis
 *   PUT    /api/kosmy-board/users/{sub}   admettre (ou mettre à jour) le compte {sub}, avec son rôle et ses restrictions
 *   DELETE /api/kosmy-board/users/{sub}   désactiver le compte {sub} : il ne peut plus entrer, sa session cesse
 *
 * Calendy n'a pas de comptes à mot de passe : un « compte » est une entrée de la liste d'accès de la connexion unique
 * (kosmy-board.js), reconnue par son `sub`. Le `sub` du jeton est la personne qui agit : elle doit avoir un compte
 * administrateur actif dans Calendy. Le `sub` de l'adresse n'est que la personne gérée.
 *
 * Rôles : « admin » (administre Calendy depuis le Board) et « member » (le calendrier seulement). Restrictions, pour un
 * membre : « lectureSeule » (aucune modification) et « agentIA » (discuter avec l'agent IA). Elles sont appliquées
 * par le serveur à chaque requête d'une session ouverte par le Board (refusRestrictions, appelée par server.js).
 * Le jeton CALENDY_TOKEN, lui, garde l'accès complet.
 */

const { langueDe } = require('./kosmy-board-admin.js');

const USERS_PATH = '/api/kosmy-board/users';
const PROTOCOLE_USERS = 'kosmy.board-users.v1';
const SUB_RE = /^[A-Za-z0-9-]{1,64}$/;
const ROLES = ['admin', 'member'];
const ROLE_ADMIN = 'admin';
const ROLE_DEFAUT = 'member';
// Les restrictions d'un membre ; un administrateur n'en a aucune.
const CHAMPS = [
  { name: 'lectureSeule', type: 'checkbox', value: false, roles: ['member'] },
  { name: 'agentIA', type: 'checkbox', value: true, roles: ['member'] },
];
const SANS_RESTRICTION = { lectureSeule: false, agentIA: true };

/** Erreur d'accès : un statut HTTP, un code du protocole, et la clé du texte (traduit selon la langue). */
class AccesErreur extends Error {
  constructor(status, code, cle, vars = {}) {
    super(cle);
    this.status = status;
    this.code = code;
    this.cle = cle;
    this.vars = vars;
  }
}

/* ---------------- textes (fr / en) ---------------- */

const TEXTES = {
  fr: {
    'role.admin': 'Administrateur',
    'role.admin.desc': 'Utilise le calendrier et administre Calendy depuis le Board (réglages, comptes).',
    'role.member': 'Membre',
    'role.member.desc': 'Utilise le calendrier, selon ses restrictions.',
    'champ.lectureSeule': 'Lecture seule',
    'champ.lectureSeule.aide': 'Voit le calendrier et l’exporte, sans rien modifier (posts, événements, images, réglages, agent IA).',
    'champ.agentIA': 'Peut utiliser l’agent IA',
    'champ.agentIA.aide': 'Discuter avec l’agent IA de Calendy (chaque message est facturé par le fournisseur d’IA).',
    'err.inactif': 'La connexion unique avec Kosmy Board n’est pas réglée dans Calendy.',
    'err.jeton': 'Jeton du Board refusé.',
    'err.non_relie': 'Ton compte Kosmy Board n’est relié à aucun accès Calendy : tu ne peux pas en gérer les comptes.',
    'err.interdit': 'Seul un administrateur de Calendy peut gérer ses comptes depuis le Board.',
    'err.desactive': 'Ton compte Calendy est désactivé : tu ne peux pas en gérer les comptes.',
    'err.introuvable': 'Adresse inconnue.',
    'err.methode': 'Méthode non prise en charge.',
    'err.corps': 'Requête illisible.',
    'err.interne': 'Erreur interne de Calendy.',
    'err.role': 'Rôle inconnu : « admin » ou « member ».',
    'err.valeurs': 'Restrictions illisibles.',
    'err.valeur': '« {champ} » : oui ou non.',
    'err.email': 'Cette adresse e-mail est déjà celle d’un autre compte Kosmy Board admis dans Calendy ({compte}). Retire-le d’abord de Calendy.',
    'err.plein': 'La liste d’accès de Calendy est pleine ({n} comptes).',
    'err.soiAdmin': 'Tu ne peux pas te retirer tes propres droits d’administration.',
    'err.soi': 'Tu ne peux pas retirer ton propre accès.',
    'err.dernierAdmin': 'Calendy doit garder au moins un administrateur actif.',
    'ok.created': 'Compte créé dans Calendy.',
    'ok.updated': 'Compte mis à jour dans Calendy.',
    'ok.deleted': 'Compte désactivé : il ne peut plus ouvrir Calendy.',
    'ok.absent': 'Aucun compte Calendy à désactiver.',
  },
  en: {
    'role.admin': 'Administrator',
    'role.admin.desc': 'Uses the calendar and administers Calendy from the Board (settings, accounts).',
    'role.member': 'Member',
    'role.member.desc': 'Uses the calendar, within their restrictions.',
    'champ.lectureSeule': 'Read only',
    'champ.lectureSeule.aide': 'Sees and exports the calendar without changing anything (posts, events, images, settings, AI agent).',
    'champ.agentIA': 'Can use the AI agent',
    'champ.agentIA.aide': 'Chat with Calendy’s AI agent (each message is billed by the AI provider).',
    'err.inactif': 'Single sign-on with Kosmy Board is not set up in Calendy.',
    'err.jeton': 'Board token rejected.',
    'err.non_relie': 'Your Kosmy Board account is not linked to any Calendy access: you cannot manage its accounts.',
    'err.interdit': 'Only a Calendy administrator can manage its accounts from the Board.',
    'err.desactive': 'Your Calendy account is deactivated: you cannot manage its accounts.',
    'err.introuvable': 'Unknown address.',
    'err.methode': 'Method not supported.',
    'err.corps': 'Unreadable request.',
    'err.interne': 'Calendy internal error.',
    'err.role': 'Unknown role: “admin” or “member”.',
    'err.valeurs': 'Unreadable restrictions.',
    'err.valeur': '“{champ}”: yes or no.',
    'err.email': 'This e-mail address already belongs to another Kosmy Board account admitted in Calendy ({compte}). Remove it from Calendy first.',
    'err.plein': 'Calendy’s access list is full ({n} accounts).',
    'err.soiAdmin': 'You cannot remove your own administration rights.',
    'err.soi': 'You cannot remove your own access.',
    'err.dernierAdmin': 'Calendy must keep at least one active administrator.',
    'ok.created': 'Account created in Calendy.',
    'ok.updated': 'Account updated in Calendy.',
    'ok.deleted': 'Account deactivated: it can no longer open Calendy.',
    'ok.absent': 'No Calendy account to deactivate.',
  },
};

const tr = (langue) => {
  const textes = TEXTES[langue] || TEXTES.fr;
  return (cle, vars = {}) => String(textes[cle] ?? TEXTES.fr[cle] ?? cle).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
};

/** Le texte d'une AccesErreur dans la langue voulue (fr par défaut, comme l'interface de Calendy). */
const messageAcces = (err, langue = 'fr') => {
  const t = tr(langue);
  return t(err.cle, { ...err.vars, champ: err.vars.champ ? t(`champ.${err.vars.champ}`) : '' });
};

/* ---------------- rôles et restrictions ---------------- */

const defauts = () => Object.fromEntries(CHAMPS.map((f) => [f.name, f.value]));

/** Rôle d'une entrée de la liste d'accès : celui choisi depuis le Board, sinon « admin » si elle a été reliée avec le jeton. */
const roleDe = (c) => (ROLES.includes(c.role) ? c.role : c.par === 'jeton' ? ROLE_ADMIN : ROLE_DEFAUT);

/** Restrictions enregistrées (complétées par les valeurs par défaut). */
const valeursDe = (c) => {
  const v = { ...defauts() };
  const brut = c.valeurs && typeof c.valeurs === 'object' ? c.valeurs : {};
  for (const f of CHAMPS) if (typeof brut[f.name] === typeof f.value) v[f.name] = brut[f.name];
  return v;
};

/** Restrictions qui s'appliquent vraiment : celles d'un membre ; un administrateur n'en a aucune. */
const restrictionsDe = (c) => (roleDe(c) === ROLE_ADMIN ? { ...SANS_RESTRICTION } : valeursDe(c));

/** Rôle et restrictions reçus du Board, revérifiés ici. Un champ absent garde sa valeur actuelle. */
function verifierAcces(corps, actuelles) {
  if (!ROLES.includes(corps.role)) throw new AccesErreur(422, 'invalid', 'err.role');
  const valeurs = { ...defauts(), ...(actuelles || {}) };
  const brut = corps.values;
  if (brut !== undefined && brut !== null) {
    if (typeof brut !== 'object' || Array.isArray(brut)) throw new AccesErreur(422, 'invalid', 'err.valeurs');
    for (const f of CHAMPS) {
      if (!(f.name in brut)) continue;
      if (typeof brut[f.name] !== 'boolean') throw new AccesErreur(422, 'invalid', 'err.valeur', { champ: f.name });
      valeurs[f.name] = brut[f.name];
    }
  }
  return { role: corps.role, valeurs };
}

/**
 * Ce qu'une session ouverte par le Board n'a pas le droit de faire, d'après ses restrictions.
 * Renvoie le message du refus (403), ou null. Appelée pour toute requête /api d'une session (pas du jeton).
 */
function refusRestrictions(methode, pathname, restrictions) {
  const r = restrictions || SANS_RESTRICTION;
  if (r.lectureSeule && methode !== 'GET' && methode !== 'HEAD') {
    return 'Ton accès à Calendy est en lecture seule : tu peux consulter et exporter le calendrier, pas le modifier.';
  }
  if (r.agentIA === false && pathname.startsWith('/api/agent/') && !(methode === 'GET' && pathname === '/api/agent/reglages')) {
    return 'Ton accès à Calendy ne comprend pas l’agent IA.';
  }
  return null;
}

/* ---------------- module ---------------- */

/**
 * @param {object} o
 * @param {object} o.kosmy module de la connexion unique (kosmy-board.js)
 * @param {Function} o.OidcErreur
 * @param {Function} o.HttpError
 * @param {Function} o.envoyer (res, status, objet) : réponse JSON de Calendy (no-store, en-têtes de sécurité)
 * @param {Function} o.lireCorps (req) : corps JSON de la requête
 */
function creerUtilisateursBoard({ kosmy, OidcErreur, HttpError, envoyer, lireCorps }) {
  async function authentifier(req, chemin) {
    try {
      const { claims, compte, admin, actif } = await kosmy.authentifierAdmin({ autorisation: req.headers.authorization, methode: req.method, chemin });
      if (!actif) throw new AccesErreur(403, 'forbidden', 'err.desactive');
      if (!admin) throw new AccesErreur(403, 'forbidden', 'err.interdit');
      return { claims, compte };
    } catch (err) {
      if (!(err instanceof OidcErreur)) throw err;
      if (err.code === 'non_relie') throw new AccesErreur(403, 'not_linked', 'err.non_relie');
      if (err.code === 'inactif') throw new AccesErreur(401, 'invalid_token', 'err.inactif');
      throw new AccesErreur(401, 'invalid_token', 'err.jeton');
    }
  }

  function schema(t) {
    return {
      protocol: PROTOCOLE_USERS,
      roles: ROLES.map((r) => ({ value: r, label: t(`role.${r}`), description: t(`role.${r}.desc`), ...(r === ROLE_ADMIN ? { admin: true } : {}) })),
      defaultRole: ROLE_DEFAUT,
      fields: CHAMPS.map((f) => ({ name: f.name, label: t(`champ.${f.name}`), type: f.type, value: f.value, help: t(`champ.${f.name}.aide`), roles: f.roles })),
      users: kosmy.utilisateurs().slice(0, 500),
    };
  }

  const concerne = (pathname) => pathname === USERS_PATH || pathname.startsWith(`${USERS_PATH}/`);

  /** Traite une requête sous /api/kosmy-board/users (pathname sans « / » final). Répond toujours en JSON. */
  async function traiter(req, res, pathname) {
    const langue = langueDe(req.headers['accept-language']);
    const t = tr(langue);
    try {
      const { claims, compte } = await authentifier(req, pathname);
      const moi = compte.sub;
      const cible = pathname.slice(USERS_PATH.length + 1);
      if (!cible) {
        if (req.method !== 'GET') throw new AccesErreur(405, 'method_not_allowed', 'err.methode');
        return envoyer(res, 200, schema(t));
      }
      if (!SUB_RE.test(cible)) throw new AccesErreur(404, 'not_found', 'err.introuvable');
      const qui = `par ${compte.nom || claims.name || '?'} <${compte.email || claims.email || moi}>`;

      if (req.method === 'PUT') {
        let corps;
        try {
          corps = await lireCorps(req);
        } catch (err) {
          if (err instanceof HttpError && err.status === 413) throw new AccesErreur(413, 'too_large', 'err.corps');
          throw new AccesErreur(400, 'invalid_request', 'err.corps');
        }
        if (!corps || typeof corps !== 'object' || Array.isArray(corps)) throw new AccesErreur(400, 'invalid_request', 'err.corps');
        const r = kosmy.appliquerAcces(cible, corps, { moi });
        console.log(`Utilisateurs Kosmy Board : ${cible} ${r.status} (${r.compte.role}), ${qui}.`);
        return envoyer(res, 200, { ok: true, status: r.status, account: r.compte.email || r.compte.nom || cible, message: t(`ok.${r.status}`) });
      }

      if (req.method === 'DELETE') {
        const fait = kosmy.desactiver(cible, { moi });
        if (fait) console.log(`Utilisateurs Kosmy Board : ${cible} désactivé, ${qui}.`);
        return envoyer(res, 200, { ok: true, message: t(fait ? 'ok.deleted' : 'ok.absent') });
      }

      throw new AccesErreur(405, 'method_not_allowed', 'err.methode');
    } catch (err) {
      if (err instanceof AccesErreur) return envoyer(res, err.status, { error: err.code, message: messageAcces(err, langue) });
      console.error('Utilisateurs Kosmy Board :', err);
      return envoyer(res, 500, { error: 'server_error', message: t('err.interne') });
    }
  }

  return { concerne, traiter };
}

module.exports = {
  creerUtilisateursBoard,
  AccesErreur,
  messageAcces,
  verifierAcces,
  refusRestrictions,
  roleDe,
  valeursDe,
  restrictionsDe,
  defauts,
  USERS_PATH,
  PROTOCOLE_USERS,
  ROLE_ADMIN,
  ROLES,
};
