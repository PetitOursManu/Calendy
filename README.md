<p align="center"><img src="assets/logo.png" width="220" alt="Logo de Calendy"></p>

# Calendy

Calendrier éditorial des réseaux sociaux de l'ESAT Elisa 30.

On y range les événements du moment (Octobre Rose, Semaine du Goût, DuoDay…) et les idées de posts qui s'y rattachent. On voit tout sur un calendrier, on valide ou on refuse chaque idée, et on exporte les posts retenus dans un fichier Excel pour la direction. Claude Desktop peut piloter l'appli : proposer des idées, valider, exporter.

- **Une page** (`public/index.html`) : HTML, CSS et JavaScript dans un seul fichier, polices comprises.
- **Un petit serveur Node** (`server.js`, et `agent.js` pour l'agent IA) : il garde les données dans un fichier `data.json` et génère l'Excel.
- **Un connecteur MCP** (`dist/calendy-mcp.js`) : un seul fichier, à copier sur le poste qui a Claude Desktop.

## Démarrer en local

Il faut Node.js 20 ou plus.

```bash
npm install
npm start
```

Ouvre ensuite http://localhost:3000. Au premier démarrage, le calendrier d'octobre 2026 (18 posts, 8 événements) est chargé depuis `seed.json`. Pour partir d'un calendrier vide, lance avec `CALENDY_NO_SEED=1`.

Les données sont dans `data/data.json`, avec une copie `data.json.bak` à chaque enregistrement. Les images sont dans `data/images/`.

## Utiliser l'appli

| Vue | À quoi elle sert |
| --- | --- |
| Calendrier | Le mois en un coup d'œil. Les événements forment des bandes sur leurs jours, les posts sont des pastilles. Un contour pointillé veut dire « pas encore décidé », un contour plein « décidé ». Le bouton + d'un jour ajoute un post à cette date. |
| À valider | Les idées en attente, un mois à la fois : des boutons en haut de page (Octobre 2026, Janvier 2027… avec le nombre d'idées) permettent de choisir le mois, ou « Tous les mois » pour tout voir. Un bouton **Liste / Calendrier** permet d'afficher les idées du mois choisi sur une grille de calendrier (avec les événements en bandes) ; un clic sur une idée l'ouvre pour la modifier, la valider ou la refuser. Sur téléphone, la grille est remplacée par un agenda jour par jour, avec la légende, les hashtags, l'idée d'image, l'explication de l'événement et le point de vigilance. Valider ou Refuser en un clic, avec un bouton Annuler. |
| Événements | Les temps forts, en liste rangée par mois (repliable) ou en **vue Calendrier** (bouton Liste / Calendrier, navigation de mois en mois, un clic sur une barre ouvre l'événement, le + d'un jour crée un événement à cette date), avec leur explication et leur lien avec Elisa30. Un badge signale ceux qui n'ont encore aucun post. |

Chaque post contient : titre, légende, hashtags, idée d'image, date et heure de publication, réseaux (Instagram, Facebook, LinkedIn), événement lié, atelier, angle, point de vigilance et statut (idée à valider, validé, planifié, refusé, publié). Des **images facultatives** peuvent être jointes à chaque post : jusqu'à **20 images** pour Instagram + Facebook (les mêmes sur les deux) et jusqu'à 20 pour LinkedIn. Une seule image = une photo ; **plusieurs images = un carrousel**, dans l'ordre choisi. Elles s'ajoutent dans le formulaire du post (le bouton n'apparaît que pour les réseaux cochés ; on peut en sélectionner plusieurs d'un coup, puis en ajouter d'autres plus tard). Chaque vignette porte son **numéro** (l'ordre de publication) ; les boutons **←** et **→** la déplacent, la croix la retire. Les changements ne sont enregistrés qu'avec le bouton Enregistrer. Dans « À valider » et dans la fiche du post, un carrousel s'affiche en vignettes numérotées. Un clic sur une image l'**ouvre en grand** (la petite loupe en bas à droite de la miniature le rappelle), y compris pour une image qui vient d'être choisie ; dans un carrousel, les boutons ‹ › ou les **flèches du clavier** passent d'une image à l'autre, et la légende indique « Image 2 sur 4 ». Un clic n'importe où, la touche Échap ou le bouton Fermer referme l'image. Le bouton **Télécharger** (« Télécharger les 4 images » pour un carrousel ; sous les images dans « À valider », et dans la fiche du post) enregistre les images sur l'ordinateur ou le téléphone, sans repasser par Canva ; chaque fichier porte un nom clair, par exemple `2026-11-23_portes-ouvertes_instagram-facebook_1.jpg`, `…_2.jpg`, etc. (sans numéro quand il n'y a qu'une image). Les images sont réduites à 1 600 px et enregistrées en JPEG par le navigateur avant l'envoi. La légende est comptée avec les hashtags, et l'appli prévient quand elle dépasse la limite d'Instagram (2 200 caractères) ou de LinkedIn (3 000).

### Texte entre crochets

Tout passage écrit **[entre crochets]** dans un champ texte (titre, légende, hashtags, idée d'image, atelier, angle, point de vigilance, et nom, explication ou lien Elisa30 d'un événement) est mis en avant automatiquement : fond jaune et texte en gras partout où le champ est affiché, fond jaune derrière le texte pendant la saisie. Pratique pour repérer ce qu'il reste à compléter avant de publier (`[date à confirmer]`, `[photo de l'équipe]`…). Rien à configurer, et le texte n'est pas modifié : les crochets restent dans les données, donc dans l'export Excel (qui ne les colore pas). Un crochet seul ou jamais refermé sur la même ligne n'est pas surligné.

### Planifier un post

Dans la fiche d'un post, choisis le statut **Planifié** : le post passe **automatiquement en « Publié »** quand sa date de publication est atteinte, à son heure si elle est renseignée (sans heure, dès le début de la journée). Sous les statuts, l'appli annonce quand le basculement aura lieu.

- Calendy **ne publie rien sur les réseaux** : il met seulement le statut à jour dans le calendrier.
- Un post dont la date et l'heure sont déjà passées ne peut pas être planifié (l'appli le refuse) : choisis une date à venir, ou « Publié ».
- Le basculement se fait chaque minute sur le serveur et avant chaque lecture de l'API, même si personne n'a la page ouverte. La page ouverte se met à jour toute seule (toutes les 20 secondes). Les dates et heures sont celles du fuseau `CALENDY_TZ` (Europe/Paris par défaut).
- Déplacer un post planifié vers une date passée est refusé pour la même raison. Les copies (clonage) repartent en « idée à valider ».

### Déplacer, cloner et fusionner des posts

Ces trois actions sont dans la fiche d'un post (boutons **Déplacer**, **Cloner** et **Fusionner…** en haut), donc aussi sur téléphone.

- **Déplacer** : choisis une nouvelle date. Le statut, le texte et les images ne changent pas. Sur le calendrier (vues Calendrier et À valider en mode Calendrier), on peut aussi **glisser un post sur un autre jour** ; un bouton Annuler apparaît.
- **Cloner** : une copie du post par date, plusieurs dates à la fois. Les copies reprennent le texte, les hashtags, l'événement et les images, carrousel compris (chaque copie a ses propres fichiers) et repartent en **idée à valider**, même si l'original est validé ou publié. Sur le calendrier, **glisser un post sur un jour avec Ctrl enfoncé** (Option sur Mac) crée une copie. Annuler supprime les copies.
- **Fusionner** : réunit deux posts qui n'ont **aucun réseau en commun** (typiquement le post Instagram et le post Facebook d'un même sujet) en un seul post prévu sur les deux réseaux. Tu choisis le second post dans une liste (les plus probables en premier : même jour, titre proche), puis, pour chaque point où les deux diffèrent (titre, légende, hashtags, date, images…), la version à garder (pour les images Instagram + Facebook, c'est le carrousel entier de l'un ou de l'autre, ou aucune image). Ce qui n'existe que d'un côté est repris automatiquement. Si les statuts diffèrent, le choix proposé par défaut est « idée à valider ». Le second post est **supprimé** et les images écartées ne sont plus utilisées ; **Annuler** remet les deux posts comme avant.

### Annuler et rétablir

En bas à droite de l'écran, partout dans l'appli (y compris par-dessus une fiche ouverte), les boutons **Annuler** et **Rétablir** reviennent en arrière ou refont la dernière action, avec **Ctrl+Z** et **Ctrl+Y** (ou Ctrl+Maj+Z ; Cmd sur Mac). Dans un champ de saisie, Ctrl+Z garde son rôle habituel : il annule la frappe. Le survol d'un bouton indique l'action concernée.

- Tout s'annule : création, modification, déplacement, statut, clonage, fusion, suppression, images. Cela vaut pour l'interface, l'agent IA et Claude Desktop. Toutes les modifications faites par l'agent en réponse à un même message s'annulent d'un coup.
- L'historique est **commun à tous les utilisateurs** : Annuler porte sur la dernière action, quelle que soit la personne qui l'a faite. Il garde les 100 dernières actions et survit au redémarrage du serveur.
- Une image retirée reste sur le disque tant qu'une annulation peut la restaurer. Elle est effacée quand l'action sort de l'historique.
- Le passage automatique de « Planifié » à « Publié » n'est pas une action de l'historique.

## Agent IA

Le bouton rond en bas à droite ouvre une petite fenêtre de discussion. L'agent agit directement sur le calendrier : ajouter ou modifier des posts et des événements, les déplacer, changer les statuts, cloner des posts, regarder leurs images. **Supprimer et fusionner demandent toujours un clic sur « Confirmer »** ; tout le reste s'annule avec le bouton Annuler.

Quand un post est ouvert, l'agent s'affiche à côté de la fiche et travaille dessus par défaut : un bouton **Corriger les fautes** est proposé, et on peut lui demander n'importe quelle modification. Ses changements sont enregistrés aussitôt et apparaissent dans la fiche ; une saisie non enregistrée sur un autre champ reste en place. Sur un post pas encore créé, il remplit simplement le formulaire, à enregistrer soi-même.

Tout se règle dans **Réglages, onglet Agent IA** : activation, nom, fournisseur (**Claude** ou **OpenRouter**), clé API, modèle, niveau de réflexion (Claude), instructions de rédaction et autorisations (supprimer, cloner, fusionner, voir les images). Le bouton **Tester la connexion** vérifie la clé et le modèle.

La clé est conservée sur le serveur dans `agent.json` (dans le dossier des données, séparé de `data.json`) et n'est jamais renvoyée au navigateur. Les variables `ANTHROPIC_API_KEY` et `OPENROUTER_API_KEY`, si elles existent, ont la priorité. Toute personne qui a accès à Calendy peut utiliser l'agent, donc consommer le crédit de cette clé. Les textes concernés, et les images si l'autorisation est cochée, sont envoyés au fournisseur choisi.

### Export Excel

Le bouton **Exporter en Excel** ouvre une fenêtre : statuts à inclure (validés, planifiés et publiés par défaut), période, et un compteur qui annonce combien de posts seront exportés. Le fichier contient deux feuilles :

- **Calendrier éditorial** : un post par ligne, avec ses images intégrées dans deux colonnes (Instagram + Facebook, LinkedIn) quand il y en a — un carrousel y apparaît en grille de vignettes, dans l'ordre, à l'intérieur de la cellule ; case « Inclure les photos » dans la fenêtre d'export, à décocher pour un fichier plus léger — avec sa date (vraie date Excel), le jour, la semaine, les réseaux, le titre, la légende, les hashtags, l'idée d'image, l'événement, la date de l'événement, son explication, l'angle, le point de vigilance et le statut en couleur. Filtres et volets figés prêts à l'emploi.
- **Événements** : les événements concernés, avec « Ce qu'il faut savoir », le lien avec Elisa30 et le nombre de posts prévus.

## Piloter l'appli depuis Claude Desktop

Le connecteur traduit les demandes de Claude en appels à Calendy. Il fonctionne avec n'importe quel modèle : tu choisis Sonnet 5.5 (ou un autre) dans Claude Desktop, et le connecteur ne change pas.

1. Installe Node.js 20 ou plus sur le poste où tourne Claude Desktop.
2. Copie `dist/calendy-mcp.js` dans un dossier, par exemple `C:\Calendy\calendy-mcp.js`. Aucun `npm install` n'est nécessaire.
3. Ajoute le connecteur au fichier de configuration de Claude Desktop (menu Paramètres, section Développeur, bouton de modification de la configuration), en t'inspirant de `claude_desktop_config.example.json` :

```json
{
  "mcpServers": {
    "calendy": {
      "command": "node",
      "args": ["C:\\Calendy\\calendy-mcp.js"],
      "env": {
        "CALENDY_URL": "http://localhost:3000",
        "CALENDY_TOKEN": "le-jeton-si-le-serveur-en-exige-un"
      }
    }
  }
}
```

4. Redémarre Claude Desktop. Les outils de Calendy apparaissent dans la conversation.

Ce que tu peux demander :

- « Propose-moi cinq idées de posts pour novembre. »
- « Qu'est-ce qui attend ma validation ? »
- « Valide les deux posts Halloween et refuse celui sur la santé mentale. »
- « Exporte les posts validés de novembre en Excel. »
- « Télécharge les photos du post sur les portes ouvertes. »
- « Déplace le post de la Semaine du Goût au 14 octobre. » / « Clone ce post sur les 3 et 10 novembre. »
- « Fusionne le post Instagram et le post Facebook sur le Téléthon » (Claude te montre les deux textes s'ils diffèrent et demande lequel garder).

Claude peut aussi joindre ou retirer des images (`ajouter_photo`, `retirer_photo`) à partir de fichiers de ton ordinateur, et enregistrer dans Téléchargements les images déjà jointes à un post (`telecharger_photo`) ; il ne crée pas d'image. Pour un carrousel, il appelle `ajouter_photo` une fois par image, dans l'ordre : chaque image s'ajoute à la suite (avec `remplacer`, elle prend la place de toutes les autres) ; `retirer_photo` retire l'image dont il donne le numéro, ou toutes avec `toutes`. Pour **réordonner** un carrousel, utilise la fiche du post dans Calendy (boutons ← →). Claude crée toujours les posts en **idée à valider** : c'est toi qui décides. Il ne valide ou ne refuse que si tu le demandes, et ne déplace, ne clone ou ne fusionne (`deplacer_post`, `cloner_post`, `fusionner_posts`) que sur ta demande. Les fichiers Excel sont enregistrés dans Téléchargements (ou dans `CALENDY_EXPORT_DIR`). La page affichée se met à jour toute seule dans les 20 secondes qui suivent une modification faite par Claude.

Si l'appli est sur un serveur, mets son adresse dans `CALENDY_URL`.

## Héberger sur un serveur (Docker, Coolify)

Le `Dockerfile` fourni construit une image légère.

1. Crée l'application à partir du dépôt ou de l'image.
2. Définis la variable **`CALENDY_TOKEN`** avec une longue valeur aléatoire (par exemple `openssl rand -hex 24`). Sans elle, quiconque atteint le serveur peut lire et modifier le calendrier.
3. Ajoute un **volume persistant sur `/data`**. Sinon les données disparaissent à chaque redéploiement.
4. Publie sur le port 3000, derrière ton reverse proxy en HTTPS.

Au premier accès, la page demande le jeton et le garde dans le navigateur. Le contrôle de santé est `GET /api/health`.

Au démarrage, les journaux du conteneur indiquent `Jeton d'accès actif : N caractères` (jamais la valeur). Le serveur ignore les espaces, retours à la ligne et guillemets qui entoureraient le jeton. Si la page répond « jeton refusé », compare ce nombre avec la longueur du jeton collé ; un refus écrit aussi `Jeton refusé : X caractères reçus, Y attendus` dans les journaux. Après avoir modifié la variable, il faut **redéployer** l'application. Évite `$` et `#` dans le jeton (certains hébergeurs les interprètent) : `openssl rand -hex 24` ne produit que des chiffres et des lettres.

Sauvegarde : copie `data.json` **et le dossier `images`** du volume. `historique.json` (annulations) et `agent.json` (réglages et clé de l'agent) y sont aussi ; ne partage pas ce dernier.

## Variables d'environnement

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port d'écoute | `3000` |
| `HOST` | Adresse d'écoute (`0.0.0.0` dans Docker) | `127.0.0.1` |
| `DATA_DIR` | Dossier de `data.json` | `./data` |
| `CALENDY_TOKEN` | Jeton d'accès à l'API (recommandé hors poste local) | aucun |
| `CALENDY_TZ` | Fuseau horaire des dates et heures des posts, utilisé pour passer les posts « Planifié » en « Publié » à l'échéance | `Europe/Paris` |
| `CALENDY_NO_SEED` | `1` pour ne pas charger `seed.json` au premier démarrage | non défini |
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | Clés de l'agent IA, prioritaires sur celles saisies dans les réglages | aucune |
| `CALENDY_HISTORIQUE_MAX` | Nombre d'actions gardées pour Annuler / Rétablir (`0` désactive l'annulation) | `100` |

Pour le connecteur : `CALENDY_URL` (défaut `http://127.0.0.1:3000`), `CALENDY_TOKEN` et `CALENDY_EXPORT_DIR`.

## Pour les développeurs

```bash
npm test                # 63 tests : API, photos, clonage, fusion, export Excel, connecteur MCP, historique, agent IA
npm run build:mcp       # régénère dist/calendy-mcp.js après un changement de mcp.js
npm run test:bundle     # relance les tests du connecteur sur le fichier empaqueté
```

API REST, sous `/api` (JSON, en-tête `Authorization: Bearer <jeton>` si un jeton est défini) :

| Route | Rôle |
| --- | --- |
| `GET /state` | Tout le calendrier (événements et posts) |
| `GET/POST /posts`, `GET/PUT/DELETE /posts/:id` | Posts (déplacer = `PUT` avec `datePublication`). Filtres de liste : `statut`, `du`, `au`, `q`, `eventId` |
| `POST /posts/statut` | Change le statut de plusieurs posts : `{ "ids": [...], "statut": "valide" }`. Le statut `planifie` est refusé (400) pour un post dont la date et l'heure sont déjà passées ; un post `planifie` passe seul en `publie` à son échéance |
| `GET/POST /evenements`, `GET/PUT/DELETE /evenements/:id` | Événements (supprimer un événement détache ses posts, sans les supprimer) |
| `POST /posts/:id/cloner` | Copies d'un post : `{ "dates": ["2026-11-03", "2026-11-10"] }`. Une copie « idée à valider » par date (doublons ignorés, 60 maximum), photos copiées. Répond `201 { "clones": [...] }` |
| `POST /posts/fusionner` | Fusionne deux posts sans réseau en commun : `{ "ids": [a, b], "garder": a, "choix": { "description": b, "photo": b } }`. `garder` (le premier par défaut) conserve son identifiant ; l'autre est supprimé. Sans `choix` pour un champ, on prend la valeur du post gardé (ou de l'autre si le premier n'a rien) ; `choix.photo` peut valoir `"aucune"`. Statuts différents sans choix : `idee`. Répond `{ "post": {...}, "supprime": id }` |
| `POST /posts/:id/photo/meta`, `POST /posts/:id/photo/linkedin` | **Ajoute** une image à la suite des autres (corps = image JPEG ou PNG brute, 8 Mo maximum, `Content-Type: image/jpeg` ou `image/png`). 20 images au plus par visuel. Répond `201` avec le post |
| `PUT /posts/:id/photo/meta`, `PUT /posts/:id/photo/linkedin` | Même envoi, mais l'image **remplace toutes** celles du visuel (ancien comportement : une seule photo). Répond `200` |
| `GET/DELETE /posts/:id/photo/meta/:fichier` (idem `linkedin`) | Lit ou retire **une** image, désignée par son nom de fichier (champ `fichier` des `photos` du post) |
| `GET/DELETE /posts/:id/photo/meta` (idem `linkedin`) | Sans nom de fichier : lit la première image, ou retire **toutes** les images du visuel (`meta` = Instagram + Facebook) |
| `PUT /posts/:id/photo/meta/ordre` (idem `linkedin`) | Nouvel ordre : `{ "fichiers": ["nom1.jpg", "nom2.jpg"] }`, avec toutes les images du visuel, une fois chacune |
| `GET /historique`, `POST /historique/annuler`, `POST /historique/retablir` | État de l'historique, annuler ou rétablir la dernière action (corps JSON `{}`). `409` s'il n'y a rien à faire |
| `GET/PUT /agent/reglages` | Réglages de l'agent, sans jamais renvoyer les clés. `PUT` partiel ; `cles: { "anthropic": null }` retire une clé |
| `GET /agent/modeles?fournisseur=` | Modèles proposés (`anthropic` ou `openrouter`) |
| `POST /agent/tester` | Vérifie la clé et le modèle enregistrés |
| `POST /agent/message` | Échange avec l'agent : `{ "messages": [...], "contexte": {...} }`. Répond `{ reponse, actions, confirmations, formulaire }` |
| `POST /agent/confirmer` | Confirme ou refuse une suppression ou une fusion : `{ "id": "...", "accepter": true }` |
| `GET /export.xlsx` | Export Excel : `statuts` (`valide,planifie,publie` par défaut, ou `all`), `du`, `au`, `photos=0` pour exclure les photos |
| `GET /health` | Contrôle de santé, sans jeton |

Le serveur refuse les requêtes dont l'en-tête `Origin` n'est pas son propre hôte, et celles dont le `Content-Type` n'est pas `application/json`, ce qui bloque les appels d'un autre site depuis le navigateur. La page est servie avec une politique de sécurité qui n'autorise aucune ressource externe.

## Licences

La police Atkinson Hyperlegible (Braille Institute) est intégrée à la page sous licence SIL Open Font License 1.1.
