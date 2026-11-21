'use strict';
/**
 * L'admin dans Kosmy Board : protocole kosmy.board-admin.v1 (docs/admin-api.md du dépôt Kosmy Board).
 *
 * Le serveur du Board appelle trois adresses avec un jeton à usage unique signé par sa clé OpenID Connect :
 *   GET  /api/kosmy-board/admin             le sommaire (l'appli, la personne, les sections)
 *   GET  /api/kosmy-board/admin/{section}   le contenu d'une section (blocs : notice, stats, fields, form, table, actions)
 *   POST /api/kosmy-board/admin/{section}   une action : { action, row?, values? }
 *
 * Le jeton est vérifié par kosmy-board.js (mêmes réglages, mêmes clés et même liste d'accès que la connexion unique).
 * Droits : seul un compte Kosmy Board relié avec le jeton (« Relier à Kosmy Board ») est administrateur ; un compte
 * admis automatiquement n'a accès qu'au calendrier. Comme dans Calendy, les réglages de la connexion unique et la liste
 * des comptes demandent en plus le jeton d'accès de Calendy.
 *
 * Chaque action passe par les mêmes fonctions que les réglages de Calendy (mêmes règles, mêmes messages d'erreur).
 * Aucun secret existant n'est jamais renvoyé : les clés et le secret client sont en écriture seule.
 */

const crypto = require('node:crypto');

const ADMIN_PATH = '/api/kosmy-board/admin';
const PROTOCOLE = 'kosmy.board-admin.v1';
const SECTION_RE = /^[a-z0-9-]{1,40}$/;
const SECTIONS = ['overview', 'general', 'agent', 'mocky', 'kosmy-board'];
const PERMISSIONS = ['supprimer', 'cloner', 'fusionner', 'images', 'mocky', 'internet'];
const FOURNISSEURS = ['anthropic', 'openrouter'];
const STATUTS = ['idee', 'valide', 'planifie', 'publie', 'refuse'];

class AdminErreur extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.texte = message || '';
  }
}

/* ---------------- textes (fr / en) ---------------- */

const TEXTES = {
  fr: {
    role: 'Administrateur',
    'err.inactif': 'La connexion unique avec Kosmy Board n’est pas réglée dans Calendy.',
    'err.jeton': 'Jeton du Board refusé.',
    'err.non_relie': 'Ce compte Kosmy Board n’est relié à aucun accès Calendy. Ouvre Calendy avec le jeton d’accès, puis Réglages → Kosmy Board → « Relier à Kosmy Board ».',
    'err.interdit': 'Ton compte Kosmy Board a accès au calendrier de Calendy, mais pas à son administration : seul un compte relié avec le jeton d’accès (Réglages → Kosmy Board → « Relier à Kosmy Board ») l’administre.',
    'err.section': 'Section inconnue.',
    'err.action': 'Action inconnue.',
    'err.methode': 'Méthode non prise en charge.',
    'err.corps': 'Requête illisible.',
    'err.interne': 'Erreur interne de Calendy.',
    'err.jetonCalendy': 'Jeton d’accès de Calendy incorrect : rien n’a été modifié.',
    'err.soi': 'Tu ne peux pas retirer ton propre compte depuis le Board : tu perdrais l’accès à cette administration.',
    'err.compte': 'Ce compte Kosmy Board n’est plus dans la liste.',
    'err.regle': 'Cette règle n’existe plus.',
    'err.cleEnv': 'Cette clé est fixée par une variable d’environnement du serveur : elle ne se retire pas ici.',
    'sec.overview': 'Vue d’ensemble',
    'sec.general': 'Général',
    'sec.agent': 'Agent IA',
    'sec.mocky': 'Visuels Mocky',
    'sec.kosmy-board': 'Kosmy Board',
    'desc.overview': 'Le calendrier éditorial de cette instance en un coup d’œil.',
    'desc.general': 'Réglages généraux de Calendy.',
    'desc.agent': 'L’assistant qui crée et modifie les posts à la demande. Les clés ne sont jamais réaffichées.',
    'desc.mocky': 'Calendy demande à Mocky le visuel d’un post. Les modèles, les règles et les consignes par modèle se choisissent dans Calendy (Réglages → Mocky).',
    'desc.kosmy-board': 'Connexion unique et comptes Kosmy Board admis. Comme dans Calendy, toute modification demande le jeton d’accès de Calendy.',
    enregistrer: 'Enregistrer',
    enregistre: 'Réglages enregistrés.',
    oui: 'Oui',
    non: 'Non',
    aucun: 'Aucun',
    'ov.calendrier': 'Calendrier',
    'ov.posts': 'Posts',
    'ov.evenements': 'Événements',
    'ov.aVenir': '30 prochains jours',
    'ov.aVenirHint': 'posts prévus',
    'ov.images': 'Images',
    'ov.comptes': 'Comptes Kosmy Board',
    'ov.comptesHint': '{n} administrateur(s)',
    'ov.instance': 'Instance',
    'ov.version': 'Version',
    'ov.adresse': 'Adresse',
    'ov.structure': 'Structure',
    'ov.fuseau': 'Fuseau horaire',
    'ov.historique': 'Annulations gardées',
    'ov.derniere': 'Dernière action',
    'ov.agent': 'Agent IA',
    'ov.mocky': 'Mocky',
    'ov.sso': 'Connexion unique',
    'ov.node': 'Node.js',
    'ov.agentActif': 'Actif : {modele}',
    'ov.agentSansCle': 'Actif, sans clé API',
    'ov.agentInactif': 'Désactivé',
    'ov.mockyPret': 'Configuré',
    'ov.mockyNon': 'Non configuré',
    'ov.ssoActive': 'Active',
    'ov.nAgentTitre': 'Agent IA sans clé',
    'ov.nAgent': 'L’agent IA est activé mais n’a pas de clé API pour {fournisseur} : renseigne-la dans la section Agent IA.',
    'ov.nAdmissionTitre': 'Admission automatique active',
    'ov.nAdmission': 'Tout compte du Board qui a l’espace Calendy entre dans le calendrier sans être relié.',
    'statut.idee': 'Idées à valider',
    'statut.valide': 'Validés',
    'statut.planifie': 'Planifiés',
    'statut.publie': 'Publiés',
    'statut.refuse': 'Refusés',
    'gen.titre': 'Structure',
    'gen.structure': 'Nom de la structure',
    'gen.structureAide': 'Affiché à côté du logo, repris dans l’export Excel et donné à l’agent IA. Laisse vide pour ne rien afficher.',
    'ag.titre': 'Réglages de l’agent',
    'ag.actif': 'Activer l’agent IA',
    'ag.nom': 'Nom de l’agent',
    'ag.fournisseur': 'Fournisseur',
    'ag.modeleAnthropic': 'Modèle Claude (Anthropic)',
    'ag.modeleOpenrouter': 'Modèle OpenRouter',
    'ag.modeleOpenrouterAide': 'L’identifiant d’un modèle qui accepte les outils, par exemple anthropic/claude-…',
    'ag.effort': 'Niveau de réflexion',
    'ag.effortAide': 'Pour Claude (Anthropic) seulement.',
    'ag.effort.low': 'Rapide et économique',
    'ag.effort.medium': 'Équilibré (recommandé)',
    'ag.effort.high': 'Approfondi',
    'ag.instructions': 'Instructions pour l’agent',
    'ag.instructionsAide': 'Ton à employer, tutoiement ou vouvoiement, règles de rédaction de ta structure…',
    'ag.perm.supprimer': 'L’agent peut supprimer des posts et des événements (après confirmation)',
    'ag.perm.cloner': 'L’agent peut cloner des posts',
    'ag.perm.fusionner': 'L’agent peut fusionner des posts (après confirmation)',
    'ag.perm.images': 'L’agent peut voir les images des posts (transmises au fournisseur d’IA, coût plus élevé)',
    'ag.perm.mocky': 'L’agent peut créer et modifier des visuels avec Mocky (si Mocky est configuré)',
    'ag.perm.internet': 'Chercher sur internet (pour vérifier les dates et les sources des événements ; chaque recherche est facturée par le fournisseur d’IA)',
    'ag.secoursFournisseur': 'Modèle de secours : fournisseur',
    'ag.secoursAucun': 'Aucun secours',
    'ag.secoursModele': 'Modèle de secours',
    'ag.secoursAide': 'Pris quand le modèle principal ne répond pas (saturé, limité, en panne), le temps d’un message. Il utilise la clé de son fournisseur.',
    'ag.cle': 'Clé API {fournisseur}',
    'ag.cleEnv': 'Fixée par la variable {variable} du serveur : pas modifiable ici.',
    'ag.cleDefinie': 'Enregistrée : laisse vide pour la garder',
    'ag.cleAide': 'Stockée sur le serveur de Calendy uniquement, jamais réaffichée.',
    'ag.outils': 'Connexion',
    'ag.tester': 'Tester la connexion',
    'ag.testerDesc': 'Un tout petit échange avec le modèle choisi, avec la clé enregistrée.',
    'ag.retirer': 'Retirer la clé {fournisseur}',
    'ag.retirerConfirm': 'La clé {fournisseur} enregistrée sera effacée du serveur.',
    'ag.cleRetiree': 'Clé retirée.',
    'mk.titre': 'Connexion et création',
    'mk.url': 'Adresse de Mocky',
    'mk.urlAide': 'Celle où tu ouvres Mocky, sans /mcp.',
    'mk.urlEnv': 'Fixée par la variable MOCKY_URL.',
    'mk.cle': 'Clé d’assistant',
    'mk.cleAide': 'Niveau « Lecture + écriture » (mocky_ak_…). Jamais réaffichée.',
    'mk.cleEnv': 'Fixée par la variable MOCKY_API_KEY.',
    'mk.redacteur': 'Qui écrit le visuel',
    'mk.redacteur.mocky': 'Mocky (son modèle d’IA s’inspire du modèle)',
    'mk.redacteur.calendy': 'L’agent IA de Calendy (recopie le modèle, le plus fidèle)',
    'mk.formatMeta': 'Format Instagram + Facebook',
    'mk.formatLinkedin': 'Format LinkedIn',
    'mk.formatDefautMeta': 'Celui de Mocky (4:5)',
    'mk.formatDefautLinkedin': 'Celui de Mocky (1,91:1)',
    'mk.format.social-square': 'Carré 1:1 (1080 × 1080)',
    'mk.format.social-portrait': 'Portrait 4:5 (1080 × 1350)',
    'mk.format.social-story': 'Story 9:16 (1080 × 1920)',
    'mk.format.social-landscape': 'Paysage 1,91:1 (1200 × 628)',
    'mk.consignes': 'Consignes pour tous les visuels',
    'mk.consignesAide': 'L’agent IA de Calendy les lit en entier ; Mocky n’en reçoit que les 300 premiers caractères.',
    'mk.choix': 'Choix du modèle',
    'mk.defaut': 'Modèle par défaut',
    'mk.sansModele': 'Sans modèle',
    'mk.inspiration': 'Inspiration : {exemples}',
    'mk.consignesModeles': 'Consignes par modèle',
    'mk.themes': 'Règles par thème',
    'mk.evenements': 'Règles par événement',
    'mk.colTheme': 'Thème',
    'mk.colEvenement': 'Événement',
    'mk.colModele': 'Modèle',
    'mk.evInconnu': 'Événement supprimé ({id})',
    'mk.retirerRegle': 'Retirer la règle',
    'mk.retirerRegleConfirm': 'Les posts concernés prendront le modèle suivant (thème, puis modèle par défaut).',
    'mk.regleRetiree': 'Règle retirée.',
    'mk.aucuneRegle': 'Aucune règle.',
    'mk.taches': 'Visuels récents',
    'mk.colPost': 'Post',
    'mk.colVisuel': 'Visuel',
    'mk.colEtat': 'État',
    'mk.colEtape': 'Étape',
    'mk.colDebut': 'Début',
    'mk.etat.en_cours': 'En cours',
    'mk.etat.fini': 'Fini',
    'mk.etat.echec': 'Échec',
    'mk.aucuneTache': 'Aucun visuel demandé depuis le dernier démarrage de Calendy.',
    'mk.visuel.meta': 'Instagram + Facebook',
    'mk.visuel.linkedin': 'LinkedIn',
    'mk.postSupprime': 'Post supprimé',
    'mk.outils': 'Connexion',
    'mk.tester': 'Tester la connexion',
    'mk.testerDesc': 'Vérifie l’adresse, la clé et les outils de Mocky.',
    'mk.retirer': 'Retirer la clé',
    'mk.retirerConfirm': 'La clé Mocky enregistrée sera effacée du serveur.',
    'kb.connexion': 'Connexion unique',
    'kb.etat': 'État',
    'kb.emetteur': 'Émetteur',
    'kb.clientId': 'Identifiant client',
    'kb.secret': 'Secret client',
    'kb.secretDefini': 'Enregistré (jamais réaffiché)',
    'kb.retour': 'Adresse de retour',
    'kb.lancement': 'Adresse de lancement',
    'kb.form': 'Modifier la connexion unique',
    'kb.formDesc': 'Changer l’émetteur, l’identifiant ou le secret client coupe aussitôt cette administration si les nouveaux réglages ne correspondent plus à ce Board.',
    'kb.secretChamp': 'Nouveau secret client',
    'kb.secretPlaceholder': 'Inchangé',
    'kb.admissionAuto': 'Admettre automatiquement tout compte du Board qui a l’espace Calendy',
    'kb.admissionAutoAide': 'Désactivé : seuls les comptes reliés peuvent entrer. Un compte admis automatiquement a accès au calendrier, pas à cette administration.',
    'kb.jeton': 'Jeton d’accès de Calendy',
    'kb.jetonAide': 'Comme dans Calendy, ces réglages sont réservés au jeton d’accès (CALENDY_TOKEN).',
    'kb.comptes': 'Comptes Kosmy Board admis',
    'kb.comptesDesc': 'Reconnus par leur identifiant Kosmy Board, jamais par leur e-mail. Pour relier un nouveau compte, ouvre Calendy avec le jeton : Réglages → Kosmy Board → « Relier à Kosmy Board ».',
    'kb.colNom': 'Nom',
    'kb.colEmail': 'E-mail',
    'kb.colRole': 'Droits',
    'kb.colRelie': 'Relié le',
    'kb.colDerniere': 'Dernière connexion',
    'kb.roleAdmin': 'Administrateur',
    'kb.roleMembre': 'Calendrier seulement',
    'kb.vous': '{nom} (toi)',
    'kb.retirer': 'Retirer',
    'kb.retirerConfirm': 'Ce compte Kosmy Board ne pourra plus ouvrir Calendy, et sa session Calendy cesse aussitôt.',
    'kb.compteRetire': 'Compte retiré de la liste.',
    'kb.aucunCompte': 'Aucun compte relié.',
  },
  en: {
    role: 'Administrator',
    'err.inactif': 'Single sign-on with Kosmy Board is not set up in Calendy.',
    'err.jeton': 'Board token rejected.',
    'err.non_relie': 'This Kosmy Board account is not linked to any Calendy access. Open Calendy with the access token, then Settings → Kosmy Board → “Link to Kosmy Board”.',
    'err.interdit': 'Your Kosmy Board account can use Calendy’s calendar but not its administration: only an account linked with the access token (Settings → Kosmy Board → “Link to Kosmy Board”) administers it.',
    'err.section': 'Unknown section.',
    'err.action': 'Unknown action.',
    'err.methode': 'Method not supported.',
    'err.corps': 'Unreadable request.',
    'err.interne': 'Calendy internal error.',
    'err.jetonCalendy': 'Wrong Calendy access token: nothing was changed.',
    'err.soi': 'You cannot remove your own account from the Board: you would lose access to this administration.',
    'err.compte': 'This Kosmy Board account is no longer in the list.',
    'err.regle': 'This rule no longer exists.',
    'err.cleEnv': 'This key is set by a server environment variable: it cannot be removed here.',
    'sec.overview': 'Overview',
    'sec.general': 'General',
    'sec.agent': 'AI agent',
    'sec.mocky': 'Mocky visuals',
    'sec.kosmy-board': 'Kosmy Board',
    'desc.overview': 'This instance’s editorial calendar at a glance.',
    'desc.general': 'Calendy’s general settings.',
    'desc.agent': 'The assistant that creates and edits posts on request. Keys are never shown again.',
    'desc.mocky': 'Calendy asks Mocky for a post’s visual. Templates, rules and per-template instructions are chosen in Calendy (Settings → Mocky).',
    'desc.kosmy-board': 'Single sign-on and admitted Kosmy Board accounts. As in Calendy, any change requires Calendy’s access token.',
    enregistrer: 'Save',
    enregistre: 'Settings saved.',
    oui: 'Yes',
    non: 'No',
    aucun: 'None',
    'ov.calendrier': 'Calendar',
    'ov.posts': 'Posts',
    'ov.evenements': 'Events',
    'ov.aVenir': 'Next 30 days',
    'ov.aVenirHint': 'planned posts',
    'ov.images': 'Images',
    'ov.comptes': 'Kosmy Board accounts',
    'ov.comptesHint': '{n} administrator(s)',
    'ov.instance': 'Instance',
    'ov.version': 'Version',
    'ov.adresse': 'Address',
    'ov.structure': 'Organisation',
    'ov.fuseau': 'Time zone',
    'ov.historique': 'Undo steps kept',
    'ov.derniere': 'Last action',
    'ov.agent': 'AI agent',
    'ov.mocky': 'Mocky',
    'ov.sso': 'Single sign-on',
    'ov.node': 'Node.js',
    'ov.agentActif': 'On: {modele}',
    'ov.agentSansCle': 'On, without an API key',
    'ov.agentInactif': 'Off',
    'ov.mockyPret': 'Set up',
    'ov.mockyNon': 'Not set up',
    'ov.ssoActive': 'On',
    'ov.nAgentTitre': 'AI agent without a key',
    'ov.nAgent': 'The AI agent is on but has no API key for {fournisseur}: add it in the AI agent section.',
    'ov.nAdmissionTitre': 'Automatic admission is on',
    'ov.nAdmission': 'Any Board account that has the Calendy space gets into the calendar without being linked.',
    'statut.idee': 'Ideas to review',
    'statut.valide': 'Approved',
    'statut.planifie': 'Scheduled',
    'statut.publie': 'Published',
    'statut.refuse': 'Rejected',
    'gen.titre': 'Organisation',
    'gen.structure': 'Organisation name',
    'gen.structureAide': 'Shown next to the logo, used in the Excel export and given to the AI agent. Leave empty to show nothing.',
    'ag.titre': 'Agent settings',
    'ag.actif': 'Turn on the AI agent',
    'ag.nom': 'Agent name',
    'ag.fournisseur': 'Provider',
    'ag.modeleAnthropic': 'Claude model (Anthropic)',
    'ag.modeleOpenrouter': 'OpenRouter model',
    'ag.modeleOpenrouterAide': 'The id of a model that supports tools, for example anthropic/claude-…',
    'ag.effort': 'Thinking effort',
    'ag.effortAide': 'Claude (Anthropic) only.',
    'ag.effort.low': 'Fast and cheap',
    'ag.effort.medium': 'Balanced (recommended)',
    'ag.effort.high': 'Thorough',
    'ag.instructions': 'Instructions for the agent',
    'ag.instructionsAide': 'Tone, formal or informal address, your organisation’s writing rules…',
    'ag.perm.supprimer': 'The agent may delete posts and events (after confirmation)',
    'ag.perm.cloner': 'The agent may clone posts',
    'ag.perm.fusionner': 'The agent may merge posts (after confirmation)',
    'ag.perm.images': 'The agent may see post images (sent to the AI provider, higher cost)',
    'ag.perm.mocky': 'The agent may create and edit visuals with Mocky (if Mocky is set up)',
    'ag.perm.internet': 'Search the internet (to check event dates and sources; each search is billed by the AI provider)',
    'ag.secoursFournisseur': 'Fallback model: provider',
    'ag.secoursAucun': 'No fallback',
    'ag.secoursModele': 'Fallback model',
    'ag.secoursAide': 'Used when the main model doesn’t answer (overloaded, rate-limited, down), for one message. It uses its provider’s key.',
    'ag.cle': '{fournisseur} API key',
    'ag.cleEnv': 'Set by the server variable {variable}: cannot be changed here.',
    'ag.cleDefinie': 'Saved: leave empty to keep it',
    'ag.cleAide': 'Stored on Calendy’s server only, never shown again.',
    'ag.outils': 'Connection',
    'ag.tester': 'Test the connection',
    'ag.testerDesc': 'A tiny exchange with the chosen model, using the saved key.',
    'ag.retirer': 'Remove the {fournisseur} key',
    'ag.retirerConfirm': 'The saved {fournisseur} key will be erased from the server.',
    'ag.cleRetiree': 'Key removed.',
    'mk.titre': 'Connection and creation',
    'mk.url': 'Mocky address',
    'mk.urlAide': 'The one where you open Mocky, without /mcp.',
    'mk.urlEnv': 'Set by the MOCKY_URL variable.',
    'mk.cle': 'Assistant key',
    'mk.cleAide': '“Read + write” level (mocky_ak_…). Never shown again.',
    'mk.cleEnv': 'Set by the MOCKY_API_KEY variable.',
    'mk.redacteur': 'Who writes the visual',
    'mk.redacteur.mocky': 'Mocky (its AI model takes inspiration from the template)',
    'mk.redacteur.calendy': 'Calendy’s AI agent (copies the template, most faithful)',
    'mk.formatMeta': 'Instagram + Facebook format',
    'mk.formatLinkedin': 'LinkedIn format',
    'mk.formatDefautMeta': 'Mocky’s own (4:5)',
    'mk.formatDefautLinkedin': 'Mocky’s own (1.91:1)',
    'mk.format.social-square': 'Square 1:1 (1080 × 1080)',
    'mk.format.social-portrait': 'Portrait 4:5 (1080 × 1350)',
    'mk.format.social-story': 'Story 9:16 (1080 × 1920)',
    'mk.format.social-landscape': 'Landscape 1.91:1 (1200 × 628)',
    'mk.consignes': 'Instructions for all visuals',
    'mk.consignesAide': 'Calendy’s AI agent reads all of them; Mocky only gets the first 300 characters.',
    'mk.choix': 'Template choice',
    'mk.defaut': 'Default template',
    'mk.sansModele': 'No template',
    'mk.inspiration': 'Inspiration: {exemples}',
    'mk.consignesModeles': 'Per-template instructions',
    'mk.themes': 'Rules by theme',
    'mk.evenements': 'Rules by event',
    'mk.colTheme': 'Theme',
    'mk.colEvenement': 'Event',
    'mk.colModele': 'Template',
    'mk.evInconnu': 'Deleted event ({id})',
    'mk.retirerRegle': 'Remove the rule',
    'mk.retirerRegleConfirm': 'Matching posts will use the next template (theme, then default template).',
    'mk.regleRetiree': 'Rule removed.',
    'mk.aucuneRegle': 'No rules.',
    'mk.taches': 'Recent visuals',
    'mk.colPost': 'Post',
    'mk.colVisuel': 'Visual',
    'mk.colEtat': 'Status',
    'mk.colEtape': 'Step',
    'mk.colDebut': 'Started',
    'mk.etat.en_cours': 'Running',
    'mk.etat.fini': 'Done',
    'mk.etat.echec': 'Failed',
    'mk.aucuneTache': 'No visual requested since Calendy last started.',
    'mk.visuel.meta': 'Instagram + Facebook',
    'mk.visuel.linkedin': 'LinkedIn',
    'mk.postSupprime': 'Deleted post',
    'mk.outils': 'Connection',
    'mk.tester': 'Test the connection',
    'mk.testerDesc': 'Checks Mocky’s address, key and tools.',
    'mk.retirer': 'Remove the key',
    'mk.retirerConfirm': 'The saved Mocky key will be erased from the server.',
    'kb.connexion': 'Single sign-on',
    'kb.etat': 'Status',
    'kb.emetteur': 'Issuer',
    'kb.clientId': 'Client ID',
    'kb.secret': 'Client secret',
    'kb.secretDefini': 'Saved (never shown again)',
    'kb.retour': 'Redirect URI',
    'kb.lancement': 'Login initiation URI',
    'kb.form': 'Change single sign-on',
    'kb.formDesc': 'Changing the issuer, client ID or client secret immediately cuts this administration off if the new settings no longer match this Board.',
    'kb.secretChamp': 'New client secret',
    'kb.secretPlaceholder': 'Unchanged',
    'kb.admissionAuto': 'Automatically admit any Board account that has the Calendy space',
    'kb.admissionAutoAide': 'Off: only linked accounts can get in. An automatically admitted account can use the calendar, not this administration.',
    'kb.jeton': 'Calendy access token',
    'kb.jetonAide': 'As in Calendy, these settings are reserved to the access token (CALENDY_TOKEN).',
    'kb.comptes': 'Admitted Kosmy Board accounts',
    'kb.comptesDesc': 'Recognised by their Kosmy Board id, never by their e-mail. To link a new account, open Calendy with the token: Settings → Kosmy Board → “Link to Kosmy Board”.',
    'kb.colNom': 'Name',
    'kb.colEmail': 'E-mail',
    'kb.colRole': 'Rights',
    'kb.colRelie': 'Linked on',
    'kb.colDerniere': 'Last sign-in',
    'kb.roleAdmin': 'Administrator',
    'kb.roleMembre': 'Calendar only',
    'kb.vous': '{nom} (you)',
    'kb.retirer': 'Remove',
    'kb.retirerConfirm': 'This Kosmy Board account will no longer be able to open Calendy, and its Calendy session stops at once.',
    'kb.compteRetire': 'Account removed from the list.',
    'kb.aucunCompte': 'No linked account.',
  },
};

/** La langue de la personne : la première de `Accept-Language` (par ordre de préférence) qui est fr ou en ; fr sinon. */
function langueDe(entete) {
  const langues = String(entete || '')
    .split(',')
    .map((morceau, i) => {
      const [tag, ...params] = morceau.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)).find(Boolean);
      return { tag: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q[1]) : 1, i };
    })
    .filter((l) => l.tag && l.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const choix = langues.find((l) => l.tag === 'fr' || l.tag === 'en');
  return choix ? choix.tag : 'fr';
}

function traducteur(langue) {
  const textes = TEXTES[langue] || TEXTES.fr;
  return (cle, vars = {}) => String(textes[cle] ?? TEXTES.fr[cle] ?? cle).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

const texte = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const NOMS_FOURNISSEURS = { anthropic: 'Anthropic', openrouter: 'OpenRouter' };
const nomChamp = (prefixe, f) => `${prefixe}${f[0].toUpperCase()}${f.slice(1)}`;

/* ---------------- module ---------------- */

/**
 * @param {object} o
 * @param {object} o.kosmy module de la connexion unique (kosmy-board.js)
 * @param {Function} o.OidcErreur
 * @param {Function} o.HttpError
 * @param {Function} o.envoyer (res, status, objet) : réponse JSON de Calendy (no-store, en-têtes de sécurité)
 * @param {Function} o.lireCorps (req) : corps JSON de la requête
 * @param {Function} o.adressePublique (req) : adresse publique de Calendy
 * @param {object} o.calendy ce que l'admin de Calendy sait faire (mêmes fonctions que ses routes)
 */
function creerAdminBoard({ kosmy, OidcErreur, HttpError, envoyer, lireCorps, adressePublique, calendy }) {
  const { agent, mocky } = calendy;

  /* ---------- authentification ---------- */

  async function authentifier(req, chemin, t) {
    try {
      const { claims, compte, admin } = await kosmy.authentifierAdmin({ autorisation: req.headers.authorization, methode: req.method, chemin });
      if (!admin) throw new AdminErreur(403, 'forbidden', t('err.interdit'));
      return { claims, compte };
    } catch (err) {
      if (!(err instanceof OidcErreur)) throw err;
      if (err.code === 'non_relie') throw new AdminErreur(403, 'not_linked', t('err.non_relie'));
      if (err.code === 'inactif') throw new AdminErreur(401, 'invalid_token', t('err.inactif'));
      throw new AdminErreur(401, 'invalid_token', t('err.jeton'));
    }
  }

  /* ---------- outils d'affichage ---------- */

  const dateHeure = (iso, langue) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(langue === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: calendy.fuseau });
  };

  function choixModele(c, t) {
    if (!c) return t('mk.sansModele');
    if (typeof c === 'string') return c || t('mk.sansModele');
    if (c.mode === 'inspiration') return t('mk.inspiration', { exemples: (c.exemples || []).join(', ') });
    return c.modele || t('mk.sansModele');
  }

  // Identifiant de ligne d'une règle par thème : court et stable (le Board borne les identifiants de ligne à 200 caractères).
  const idTheme = (theme) => `t-${crypto.createHash('sha256').update(String(theme)).digest('base64url').slice(0, 24)}`;

  /* ---------- sections ---------- */

  function sectionOverview(t, langue, req) {
    calendy.publierPostsEchus();
    const { posts, evenements } = calendy.donnees();
    const parStatut = Object.fromEntries(STATUTS.map((s) => [s, posts.filter((p) => p.statut === s).length]));
    const aujourdhui = calendy.aujourdhui();
    const fin = new Date(`${aujourdhui}T00:00:00Z`);
    fin.setUTCDate(fin.getUTCDate() + 30);
    const limite = fin.toISOString().slice(0, 10);
    const aVenir = posts.filter((p) => p.datePublication >= aujourdhui && p.datePublication <= limite && p.statut !== 'refuse').length;
    const images = posts.reduce((n, p) => n + calendy.nombreImages(p), 0);
    const sso = kosmy.publics(adressePublique(req));
    const a = agent.publics();
    const m = mocky.publics();
    const cleAgent = a.cles[a.fournisseur] && a.cles[a.fournisseur].definie;
    const histo = calendy.etatHistorique();
    const blocs = [];
    if (a.actif && !cleAgent) blocs.push({ type: 'notice', tone: 'warning', title: t('ov.nAgentTitre'), text: t('ov.nAgent', { fournisseur: NOMS_FOURNISSEURS[a.fournisseur] || a.fournisseur }) });
    if (sso.admissionAuto) blocs.push({ type: 'notice', tone: 'info', title: t('ov.nAdmissionTitre'), text: t('ov.nAdmission') });
    blocs.push({
      type: 'stats',
      title: t('ov.calendrier'),
      items: [
        { label: t('ov.posts'), value: posts.length },
        ...STATUTS.map((s) => ({ label: t(`statut.${s}`), value: parStatut[s] })),
        { label: t('ov.aVenir'), value: aVenir, hint: t('ov.aVenirHint') },
        { label: t('ov.evenements'), value: evenements.length },
        { label: t('ov.images'), value: images },
        { label: t('ov.comptes'), value: sso.comptes.length, hint: t('ov.comptesHint', { n: sso.comptes.filter((c) => c.par === 'jeton').length }) },
      ],
    });
    blocs.push({
      type: 'fields',
      title: t('ov.instance'),
      items: [
        { label: t('ov.version'), value: calendy.version },
        { label: t('ov.adresse'), value: adressePublique(req) },
        { label: t('ov.structure'), value: calendy.nomStructure() || '—' },
        { label: t('ov.fuseau'), value: calendy.fuseau },
        { label: t('ov.historique'), value: String(calendy.historiqueMax) },
        { label: t('ov.derniere'), value: histo.annuler ? histo.annuler.libelle : '—' },
        { label: t('ov.agent'), value: !a.actif ? t('ov.agentInactif') : cleAgent ? t('ov.agentActif', { modele: a.modeles[a.fournisseur] || '—' }) : t('ov.agentSansCle') },
        { label: t('ov.mocky'), value: m.pret ? t('ov.mockyPret') : t('ov.mockyNon') },
        { label: t('ov.sso'), value: sso.actif ? t('ov.ssoActive') : t('non') },
        { label: t('ov.node'), value: process.version },
      ],
    });
    return { id: 'overview', title: t('sec.overview'), description: t('desc.overview'), blocks: blocs };
  }

  function sectionGeneral(t) {
    return {
      id: 'general',
      title: t('sec.general'),
      description: t('desc.general'),
      blocks: [{
        type: 'form', id: 'general', title: t('gen.titre'), action: 'save-general', submit: t('enregistrer'),
        fields: [{ name: 'structure', label: t('gen.structure'), type: 'text', value: calendy.nomStructure(), maxLength: 80, help: t('gen.structureAide') }],
      }],
    };
  }

  function sectionAgent(t) {
    const a = agent.publics();
    const modelesClaude = [...a.modelesClaude];
    const actuel = a.modeles.anthropic;
    if (actuel && !modelesClaude.some((x) => x.id === actuel)) modelesClaude.push({ id: actuel, nom: actuel });
    const champCle = (f) => {
      const info = a.cles[f];
      const nom = NOMS_FOURNISSEURS[f];
      if (info.source === 'env') return { name: nomChamp('cle', f), label: t('ag.cle', { fournisseur: nom }), type: 'password', readOnly: true, help: t('ag.cleEnv', { variable: info.variable }) };
      return { name: nomChamp('cle', f), label: t('ag.cle', { fournisseur: nom }), type: 'password', maxLength: 500, help: t('ag.cleAide'), ...(info.definie ? { placeholder: t('ag.cleDefinie') } : {}) };
    };
    const outils = [{ id: 'test-agent', label: t('ag.tester'), description: t('ag.testerDesc') }];
    for (const f of FOURNISSEURS) {
      if (a.cles[f].source === 'reglages') {
        const nom = NOMS_FOURNISSEURS[f];
        outils.push({ id: `remove-key-${f}`, label: t('ag.retirer', { fournisseur: nom }), danger: true, confirm: t('ag.retirerConfirm', { fournisseur: nom }) });
      }
    }
    return {
      id: 'agent',
      title: t('sec.agent'),
      description: t('desc.agent'),
      blocks: [
        {
          type: 'form', id: 'agent', title: t('ag.titre'), action: 'save-agent', submit: t('enregistrer'),
          fields: [
            { name: 'actif', label: t('ag.actif'), type: 'checkbox', value: Boolean(a.actif) },
            { name: 'nom', label: t('ag.nom'), type: 'text', value: a.nom, required: true, maxLength: 60 },
            { name: 'fournisseur', label: t('ag.fournisseur'), type: 'select', value: a.fournisseur, options: [{ value: 'anthropic', label: 'Claude (Anthropic)' }, { value: 'openrouter', label: 'OpenRouter' }] },
            { name: 'modeleAnthropic', label: t('ag.modeleAnthropic'), type: 'select', value: actuel, options: modelesClaude.map((x) => ({ value: x.id, label: x.nom })) },
            { name: 'modeleOpenrouter', label: t('ag.modeleOpenrouter'), type: 'text', value: a.modeles.openrouter || '', maxLength: 120, placeholder: 'anthropic/claude-…', help: t('ag.modeleOpenrouterAide') },
            { name: 'effort', label: t('ag.effort'), type: 'select', value: a.effort, help: t('ag.effortAide'), options: ['low', 'medium', 'high'].map((e) => ({ value: e, label: t(`ag.effort.${e}`) })) },
            { name: 'instructions', label: t('ag.instructions'), type: 'textarea', value: a.instructions || '', maxLength: 4000, placeholder: t('ag.instructionsAide') },
            { name: 'secoursFournisseur', label: t('ag.secoursFournisseur'), type: 'select', value: a.secours?.fournisseur || '', options: [{ value: '', label: t('ag.secoursAucun') }, { value: 'anthropic', label: 'Claude (Anthropic)' }, { value: 'openrouter', label: 'OpenRouter' }] },
            { name: 'secoursModele', label: t('ag.secoursModele'), type: 'text', value: a.secours?.modele || '', maxLength: 120, help: t('ag.secoursAide') },
            ...PERMISSIONS.map((p) => ({ name: `perm-${p}`, label: t(`ag.perm.${p}`), type: 'checkbox', value: Boolean(a.permissions[p]) })),
            ...FOURNISSEURS.map(champCle),
          ],
        },
        { type: 'actions', title: t('ag.outils'), items: outils },
      ],
    };
  }

  function sectionMocky(t, langue) {
    const m = mocky.publics();
    const urlEnv = m.urlSource === 'env';
    const cleEnv = m.cle.source === 'env';
    const formats = (defaut) => [{ value: '', label: t(defaut) }, ...Object.keys(mocky.FORMATS).map((id) => ({ value: id, label: t(`mk.format.${id}`) }))];
    const { posts, evenements } = calendy.donnees();
    const nomEvenement = (id) => {
      const ev = evenements.find((e) => e.id === id);
      return ev ? ev.nom : t('mk.evInconnu', { id });
    };
    const defaut = m.defautMode === 'inspiration' ? { mode: 'inspiration', exemples: m.defautExemples || [] } : m.modeleDefaut;
    const retirerRegle = { id: 'remove-rule', label: t('mk.retirerRegle'), danger: true, confirm: t('mk.retirerRegleConfirm') };
    const taches = mocky.listerTaches().slice(0, 30);
    const tonEtat = { en_cours: 'warning', fini: 'success', echec: 'danger' };
    const outils = [{ id: 'test-mocky', label: t('mk.tester'), description: t('mk.testerDesc') }];
    if (m.cle.source === 'reglages') outils.push({ id: 'remove-key', label: t('mk.retirer'), danger: true, confirm: t('mk.retirerConfirm') });
    return {
      id: 'mocky',
      title: t('sec.mocky'),
      description: t('desc.mocky'),
      blocks: [
        {
          type: 'form', id: 'mocky', title: t('mk.titre'), action: 'save-mocky', submit: t('enregistrer'),
          fields: [
            { name: 'url', label: t('mk.url'), type: 'url', value: m.url || '', maxLength: 300, placeholder: 'https://mocky.exemple.fr', help: t(urlEnv ? 'mk.urlEnv' : 'mk.urlAide'), ...(urlEnv ? { readOnly: true } : {}) },
            cleEnv
              ? { name: 'cle', label: t('mk.cle'), type: 'password', readOnly: true, help: t('mk.cleEnv') }
              : { name: 'cle', label: t('mk.cle'), type: 'password', maxLength: 300, help: t('mk.cleAide'), placeholder: m.cle.definie ? t('ag.cleDefinie') : 'mocky_ak_…' },
            { name: 'redacteur', label: t('mk.redacteur'), type: 'select', value: m.redacteur === 'calendy' ? 'calendy' : 'mocky', options: ['mocky', 'calendy'].map((r) => ({ value: r, label: t(`mk.redacteur.${r}`) })) },
            { name: 'formatMeta', label: t('mk.formatMeta'), type: 'select', value: m.formats.meta || '', options: formats('mk.formatDefautMeta') },
            { name: 'formatLinkedin', label: t('mk.formatLinkedin'), type: 'select', value: m.formats.linkedin || '', options: formats('mk.formatDefautLinkedin') },
            { name: 'consignes', label: t('mk.consignes'), type: 'textarea', value: m.consignes || '', maxLength: 3000, help: t('mk.consignesAide') },
          ],
        },
        { type: 'actions', title: t('mk.outils'), items: outils },
        {
          type: 'fields', title: t('mk.choix'),
          items: [
            { label: t('mk.defaut'), value: choixModele(defaut, t) },
            { label: t('mk.consignesModeles'), value: Object.keys(m.consignesModeles || {}).join(', ') || t('aucun') },
          ],
        },
        {
          type: 'table', id: 'themes', title: t('mk.themes'),
          columns: [{ key: 'theme', label: t('mk.colTheme') }, { key: 'modele', label: t('mk.colModele') }],
          rows: m.themes.slice(0, 500).map((r) => ({ id: idTheme(r.theme), cells: { theme: r.theme, modele: choixModele(r.mode === 'inspiration' ? r : r.modele, t) }, actions: ['remove-rule'] })),
          rowActions: [retirerRegle],
          empty: t('mk.aucuneRegle'),
        },
        {
          type: 'table', id: 'evenements', title: t('mk.evenements'),
          columns: [{ key: 'evenement', label: t('mk.colEvenement') }, { key: 'modele', label: t('mk.colModele') }],
          rows: Object.entries(m.evenements).slice(0, 500).map(([id, c]) => ({ id, cells: { evenement: nomEvenement(id), modele: choixModele(c, t) }, actions: ['remove-rule'] })),
          rowActions: [retirerRegle],
          empty: t('mk.aucuneRegle'),
        },
        {
          type: 'table', id: 'taches', title: t('mk.taches'),
          columns: [{ key: 'post', label: t('mk.colPost') }, { key: 'visuel', label: t('mk.colVisuel') }, { key: 'etat', label: t('mk.colEtat') }, { key: 'etape', label: t('mk.colEtape') }, { key: 'debut', label: t('mk.colDebut') }],
          rows: taches.map((x) => {
            const post = posts.find((p) => p.id === x.postId);
            return {
              id: x.id,
              cells: {
                post: post ? post.titre : t('mk.postSupprime'),
                visuel: t(`mk.visuel.${x.visuel}`),
                etat: { text: t(`mk.etat.${x.etat}`), tone: tonEtat[x.etat] || 'muted' },
                etape: texte(x.etat === 'echec' ? x.message : x.etape || x.message).slice(0, 300),
                debut: dateHeure(x.debut, langue),
              },
            };
          }),
          empty: t('mk.aucuneTache'),
        },
      ],
    };
  }

  function sectionKosmy(t, langue, req, moi) {
    const k = kosmy.publics(adressePublique(req));
    return {
      id: 'kosmy-board',
      title: t('sec.kosmy-board'),
      description: t('desc.kosmy-board'),
      blocks: [
        {
          type: 'fields', title: t('kb.connexion'),
          items: [
            { label: t('kb.etat'), value: k.actif ? t('ov.ssoActive') : t('non') },
            { label: t('kb.emetteur'), value: k.emetteur },
            { label: t('kb.clientId'), value: k.clientId },
            { label: t('kb.secret'), value: k.secretDefini ? t('kb.secretDefini') : t('aucun') },
            { label: t('kb.retour'), value: k.adresseRetour },
            { label: t('kb.lancement'), value: k.adresseLancement },
          ],
        },
        { type: 'notice', tone: 'info', title: t('kb.comptes'), text: t('kb.comptesDesc') },
        {
          type: 'table', id: 'comptes',
          columns: [
            { key: 'nom', label: t('kb.colNom') }, { key: 'email', label: t('kb.colEmail') }, { key: 'role', label: t('kb.colRole') },
            { key: 'relie', label: t('kb.colRelie') }, { key: 'derniere', label: t('kb.colDerniere') },
          ],
          rows: k.comptes.slice(0, 500).map((c) => {
            const nom = c.nom || c.email || c.sub;
            return {
              id: c.sub,
              cells: {
                nom: c.sub === moi ? t('kb.vous', { nom }) : nom,
                email: c.email,
                role: c.par === 'jeton' ? { text: t('kb.roleAdmin'), tone: 'success' } : { text: t('kb.roleMembre'), tone: 'muted' },
                relie: dateHeure(c.relieLe, langue),
                derniere: dateHeure(c.derniereConnexion, langue),
              },
              // On ne se retire pas soi-même : on perdrait l'accès à cette administration.
              actions: c.sub === moi ? [] : ['remove-account'],
            };
          }),
          rowActions: [{
            id: 'remove-account', label: t('kb.retirer'), danger: true, confirm: t('kb.retirerConfirm'),
            fields: [{ name: 'jeton', label: t('kb.jeton'), type: 'password', required: true, help: t('kb.jetonAide') }],
          }],
          empty: t('kb.aucunCompte'),
        },
        {
          type: 'form', id: 'sso', title: t('kb.form'), description: t('kb.formDesc'), action: 'save-sso', submit: t('enregistrer'),
          fields: [
            { name: 'emetteur', label: t('kb.emetteur'), type: 'url', value: k.emetteur, required: true, maxLength: 500 },
            { name: 'clientId', label: t('kb.clientId'), type: 'text', value: k.clientId, required: true, maxLength: 200 },
            { name: 'secret', label: t('kb.secretChamp'), type: 'password', maxLength: 500, placeholder: t('kb.secretPlaceholder') },
            { name: 'admissionAuto', label: t('kb.admissionAuto'), type: 'checkbox', value: Boolean(k.admissionAuto), help: t('kb.admissionAutoAide') },
            { name: 'jeton', label: t('kb.jeton'), type: 'password', required: true, help: t('kb.jetonAide') },
          ],
        },
      ],
    };
  }

  function section(id, ctx) {
    const { t, langue, req, moi } = ctx;
    switch (id) {
      case 'overview': return sectionOverview(t, langue, req);
      case 'general': return sectionGeneral(t);
      case 'agent': return sectionAgent(t);
      case 'mocky': return sectionMocky(t, langue);
      case 'kosmy-board': return sectionKosmy(t, langue, req, moi);
      default: return null;
    }
  }

  /* ---------- actions : les mêmes fonctions que les réglages de Calendy ---------- */

  async function agir(id, corps, ctx) {
    const { t, req, moi } = ctx;
    const v = corps.values && typeof corps.values === 'object' && !Array.isArray(corps.values) ? corps.values : {};
    const a = corps.action;
    const inconnue = () => new AdminErreur(404, 'not_found', t('err.action'));

    if (id === 'general' && a === 'save-general') {
      calendy.modifierReglages({ structure: texte(v.structure) });
      return { message: t('enregistre') };
    }

    if (id === 'agent') {
      if (a === 'save-agent') {
        const cles = agent.publics().cles;
        const body = {};
        if ('actif' in v) body.actif = v.actif === true;
        if ('nom' in v) body.nom = texte(v.nom);
        if ('fournisseur' in v) body.fournisseur = v.fournisseur;
        if ('effort' in v) body.effort = v.effort;
        if ('instructions' in v) body.instructions = texte(v.instructions);
        const modeles = {};
        for (const f of FOURNISSEURS) if (nomChamp('modele', f) in v) modeles[f] = texte(v[nomChamp('modele', f)]);
        if (Object.keys(modeles).length) body.modeles = modeles;
        const permissions = {};
        for (const p of PERMISSIONS) if (`perm-${p}` in v) permissions[p] = v[`perm-${p}`] === true;
        if (Object.keys(permissions).length) body.permissions = permissions;
        // Modèle de secours : mêmes règles que les réglages de Calendy (agent.modifier).
        const secours = {};
        if ('secoursFournisseur' in v) secours.fournisseur = texte(v.secoursFournisseur);
        if ('secoursModele' in v) secours.modele = texte(v.secoursModele);
        if (Object.keys(secours).length) body.secours = secours;
        // Clés en écriture seule : vide = inchangée ; une clé venue d'une variable d'environnement ne se remplace pas ici.
        const nouvelles = {};
        for (const f of FOURNISSEURS) {
          const cle = texte(v[nomChamp('cle', f)]).trim();
          if (cle && cles[f].source !== 'env') nouvelles[f] = cle;
        }
        if (Object.keys(nouvelles).length) body.cles = nouvelles;
        agent.modifier(body);
        return { message: t('enregistre') };
      }
      if (a === 'test-agent') return { message: (await agent.tester()).message };
      const m = /^remove-key-(anthropic|openrouter)$/.exec(String(a || ''));
      if (m) {
        if (agent.publics().cles[m[1]].source === 'env') throw new AdminErreur(422, 'invalid', t('err.cleEnv'));
        agent.modifier({ cles: { [m[1]]: null } });
        return { message: t('ag.cleRetiree') };
      }
      throw inconnue();
    }

    if (id === 'mocky') {
      const m = mocky.publics();
      if (a === 'save-mocky') {
        const body = {};
        if ('url' in v && m.urlSource !== 'env') body.url = texte(v.url);
        const cle = texte(v.cle).trim();
        if (cle && m.cle.source !== 'env') body.cle = cle;
        if ('redacteur' in v) body.redacteur = v.redacteur;
        if ('formatMeta' in v || 'formatLinkedin' in v) {
          body.formats = {};
          if ('formatMeta' in v) body.formats.meta = texte(v.formatMeta);
          if ('formatLinkedin' in v) body.formats.linkedin = texte(v.formatLinkedin);
        }
        if ('consignes' in v) body.consignes = texte(v.consignes);
        mocky.modifier(body);
        return { message: t('enregistre') };
      }
      if (a === 'test-mocky') return { message: (await mocky.tester()).message };
      if (a === 'remove-key') {
        if (m.cle.source === 'env') throw new AdminErreur(422, 'invalid', t('err.cleEnv'));
        mocky.modifier({ cle: null });
        return { message: t('ag.cleRetiree') };
      }
      if (a === 'remove-rule') {
        const ligne = texte(corps.row);
        const themes = m.themes.filter((r) => idTheme(r.theme) !== ligne);
        if (themes.length !== m.themes.length) {
          mocky.modifier({ themes });
          return { message: t('mk.regleRetiree') };
        }
        if (Object.prototype.hasOwnProperty.call(m.evenements, ligne)) {
          const evenements = { ...m.evenements };
          delete evenements[ligne];
          mocky.modifier({ evenements });
          return { message: t('mk.regleRetiree') };
        }
        throw new AdminErreur(404, 'not_found', t('err.regle'));
      }
      throw inconnue();
    }

    if (id === 'kosmy-board') {
      const base = adressePublique(req);
      // Comme dans Calendy : ces réglages sont réservés au jeton d'accès, redemandé ici à chaque fois.
      const jetonOk = () => {
        if (!calendy.jetonValide(texte(v.jeton))) throw new AdminErreur(422, 'invalid', t('err.jetonCalendy'));
      };
      if (a === 'save-sso') {
        jetonOk();
        const body = { emetteur: texte(v.emetteur), clientId: texte(v.clientId), admissionAuto: v.admissionAuto === true };
        const secret = texte(v.secret).trim();
        if (secret) body.secret = secret; // vide : le secret enregistré est gardé
        kosmy.modifier(body, base);
        return { message: t('enregistre') };
      }
      if (a === 'remove-account') {
        const sub = texte(corps.row);
        if (!kosmy.publics(base).comptes.some((c) => c.sub === sub)) throw new AdminErreur(404, 'not_found', t('err.compte'));
        if (sub === moi) throw new AdminErreur(422, 'invalid', t('err.soi'));
        jetonOk();
        kosmy.retirer(sub, base);
        return { message: t('kb.compteRetire') };
      }
      throw inconnue();
    }

    throw inconnue();
  }

  /* ---------- point d'entrée ---------- */

  const concerne = (pathname) => pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);

  /** Traite une requête sous /api/kosmy-board/admin (pathname sans « / » final). Répond toujours en JSON. */
  async function traiter(req, res, pathname) {
    const langue = langueDe(req.headers['accept-language']);
    const t = traducteur(langue);
    try {
      const { claims, compte } = await authentifier(req, pathname, t);
      const ctx = { t, langue, req, moi: compte.sub };
      const id = pathname.slice(ADMIN_PATH.length + 1);
      if (!id) {
        if (req.method !== 'GET') throw new AdminErreur(405, 'method_not_allowed', t('err.methode'));
        const structure = calendy.nomStructure();
        return envoyer(res, 200, {
          protocol: PROTOCOLE,
          app: { name: structure ? `Calendy · ${structure}` : 'Calendy', version: calendy.version },
          user: { name: compte.nom || compte.email || claims.name || claims.email || compte.sub, role: t('role') },
          sections: SECTIONS.map((s) => ({ id: s, title: t(`sec.${s}`) })),
        });
      }
      if (!SECTION_RE.test(id) || !SECTIONS.includes(id)) throw new AdminErreur(404, 'not_found', t('err.section'));
      if (req.method === 'GET') return envoyer(res, 200, section(id, ctx));
      if (req.method !== 'POST') throw new AdminErreur(405, 'method_not_allowed', t('err.methode'));
      let corps;
      try {
        corps = await lireCorps(req);
      } catch (err) {
        if (err instanceof HttpError && err.status === 413) throw new AdminErreur(413, 'too_large', err.message);
        throw new AdminErreur(400, 'invalid_request', t('err.corps'));
      }
      if (!corps || typeof corps !== 'object' || Array.isArray(corps) || typeof corps.action !== 'string') {
        throw new AdminErreur(400, 'invalid_request', t('err.corps'));
      }
      const resultat = await agir(id, corps, ctx);
      // Le Board donne le nom et l'e-mail pour le journal seulement ; le compte, lui, vient du `sub`.
      console.log(`Admin dans Kosmy Board : ${id} → ${corps.action}${corps.row ? ` (${String(corps.row).slice(0, 80)})` : ''}, par ${compte.nom || claims.name || '?'} <${compte.email || claims.email || compte.sub}>.`);
      return envoyer(res, 200, { ok: true, ...resultat, section: section(id, ctx) });
    } catch (err) {
      if (err instanceof AdminErreur) return envoyer(res, err.status, { error: err.code, ...(err.texte ? { message: err.texte } : {}) });
      // Saisie refusée par les règles de Calendy : son message, tel quel.
      if (err instanceof HttpError) {
        const codes = { 400: 'invalid', 404: 'not_found', 409: 'conflict', 413: 'too_large' };
        const status = codes[err.status] ? err.status : 422;
        return envoyer(res, status, { error: codes[err.status] || 'failed', message: err.message });
      }
      console.error('Admin dans Kosmy Board :', err);
      return envoyer(res, 500, { error: 'server_error', message: t('err.interne') });
    }
  }

  return { concerne, traiter };
}

module.exports = { creerAdminBoard, langueDe, ADMIN_PATH, PROTOCOLE };
