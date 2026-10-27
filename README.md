<p align="center"><img src="assets/logo.svg" width="88" alt="Logo de Calendy"></p>

# Calendy

Calendrier éditorial des réseaux sociaux de l'ESAT Elisa 30.

On y range les événements du moment (Octobre Rose, Semaine du Goût, DuoDay…) et les idées de posts qui s'y rattachent. On voit tout sur un calendrier, on valide ou on refuse chaque idée, et on exporte les posts retenus dans un fichier Excel pour la direction. Claude Desktop peut piloter l'appli : proposer des idées, valider, exporter.

- **Une page** (`public/index.html`) : HTML, CSS et JavaScript dans un seul fichier, polices comprises.
- **Un petit serveur Node** (`server.js`) : il garde les données dans un fichier `data.json` et génère l'Excel.
- **Un connecteur MCP** (`dist/calendy-mcp.js`) : un seul fichier, à copier sur le poste qui a Claude Desktop.

## Démarrer en local

Il faut Node.js 20 ou plus.

```bash
npm install
npm start
```

Ouvre ensuite http://localhost:3000. Au premier démarrage, le calendrier d'octobre 2026 (18 posts, 8 événements) est chargé depuis `seed.json`. Pour partir d'un calendrier vide, lance avec `CALENDY_NO_SEED=1`.

Les données sont dans `data/data.json`, avec une copie `data.json.bak` à chaque enregistrement. Les photos sont dans `data/images/`.

## Utiliser l'appli

| Vue | À quoi elle sert |
| --- | --- |
| Calendrier | Le mois en un coup d'œil. Les événements forment des bandes sur leurs jours, les posts sont des pastilles. Un contour pointillé veut dire « pas encore décidé », un contour plein « décidé ». Le bouton + d'un jour ajoute un post à cette date. |
| À valider | Les idées en attente, avec la légende, les hashtags, l'idée d'image, l'explication de l'événement et le point de vigilance. Valider ou Refuser en un clic, avec un bouton Annuler. |
| Événements | Les temps forts, avec leur explication et leur lien avec Elisa30. Un badge signale ceux qui n'ont encore aucun post. |

Chaque post contient : titre, légende, hashtags, idée d'image, date et heure de publication, réseaux (Instagram, Facebook, LinkedIn), événement lié, atelier, angle, point de vigilance et statut (idée à valider, validé, refusé, publié). Une **photo facultative** peut être jointe à chaque post : une pour Instagram + Facebook (la même sur les deux), une pour LinkedIn. Elle s'ajoute dans le formulaire du post (le bouton n'apparaît que pour les réseaux cochés), s'affiche dans « À valider » et se retire d'un clic. Les photos sont réduites à 1 600 px et enregistrées en JPEG par le navigateur avant l'envoi. La légende est comptée avec les hashtags, et l'appli prévient quand elle dépasse la limite d'Instagram (2 200 caractères) ou de LinkedIn (3 000).

### Export Excel

Le bouton **Exporter en Excel** ouvre une fenêtre : statuts à inclure (validés et publiés par défaut), période, et un compteur qui annonce combien de posts seront exportés. Le fichier contient deux feuilles :

- **Calendrier éditorial** : un post par ligne, avec ses photos intégrées dans deux colonnes (Instagram + Facebook, LinkedIn) quand il y en a — case « Inclure les photos » dans la fenêtre d'export, à décocher pour un fichier plus léger — avec sa date (vraie date Excel), le jour, la semaine, les réseaux, le titre, la légende, les hashtags, l'idée d'image, l'événement, la date de l'événement, son explication, l'angle, le point de vigilance et le statut en couleur. Filtres et volets figés prêts à l'emploi.
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

Claude peut aussi joindre ou retirer une photo (`ajouter_photo`, `retirer_photo`) à partir d'un fichier de ton ordinateur ; il ne crée pas d'image. Claude crée toujours les posts en **idée à valider** : c'est toi qui décides. Il ne valide ou ne refuse que si tu le demandes. Les fichiers Excel sont enregistrés dans Téléchargements (ou dans `CALENDY_EXPORT_DIR`). La page affichée se met à jour toute seule dans les 20 secondes qui suivent une modification faite par Claude.

Si l'appli est sur un serveur, mets son adresse dans `CALENDY_URL`.

## Héberger sur un serveur (Docker, Coolify)

Le `Dockerfile` fourni construit une image légère.

1. Crée l'application à partir du dépôt ou de l'image.
2. Définis la variable **`CALENDY_TOKEN`** avec une longue valeur aléatoire (par exemple `openssl rand -hex 24`). Sans elle, quiconque atteint le serveur peut lire et modifier le calendrier.
3. Ajoute un **volume persistant sur `/data`**. Sinon les données disparaissent à chaque redéploiement.
4. Publie sur le port 3000, derrière ton reverse proxy en HTTPS.

Au premier accès, la page demande le jeton et le garde dans le navigateur. Le contrôle de santé est `GET /api/health`.

Au démarrage, les journaux du conteneur indiquent `Jeton d'accès actif : N caractères` (jamais la valeur). Le serveur ignore les espaces, retours à la ligne et guillemets qui entoureraient le jeton. Si la page répond « jeton refusé », compare ce nombre avec la longueur du jeton collé ; un refus écrit aussi `Jeton refusé : X caractères reçus, Y attendus` dans les journaux. Après avoir modifié la variable, il faut **redéployer** l'application. Évite `$` et `#` dans le jeton (certains hébergeurs les interprètent) : `openssl rand -hex 24` ne produit que des chiffres et des lettres.

Sauvegarde : copie `data.json` **et le dossier `images`** du volume.

## Variables d'environnement

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` | Port d'écoute | `3000` |
| `HOST` | Adresse d'écoute (`0.0.0.0` dans Docker) | `127.0.0.1` |
| `DATA_DIR` | Dossier de `data.json` | `./data` |
| `CALENDY_TOKEN` | Jeton d'accès à l'API (recommandé hors poste local) | aucun |
| `CALENDY_NO_SEED` | `1` pour ne pas charger `seed.json` au premier démarrage | non défini |

Pour le connecteur : `CALENDY_URL` (défaut `http://127.0.0.1:3000`), `CALENDY_TOKEN` et `CALENDY_EXPORT_DIR`.

## Pour les développeurs

```bash
npm test                # 27 tests : API, photos, export Excel, connecteur MCP
npm run build:mcp       # régénère dist/calendy-mcp.js après un changement de mcp.js
npm run test:bundle     # relance les tests du connecteur sur le fichier empaqueté
```

API REST, sous `/api` (JSON, en-tête `Authorization: Bearer <jeton>` si un jeton est défini) :

| Route | Rôle |
| --- | --- |
| `GET /state` | Tout le calendrier (événements et posts) |
| `GET/POST /posts`, `GET/PUT/DELETE /posts/:id` | Posts. Filtres de liste : `statut`, `du`, `au`, `q`, `eventId` |
| `POST /posts/statut` | Change le statut de plusieurs posts : `{ "ids": [...], "statut": "valide" }` |
| `GET/POST /evenements`, `GET/PUT/DELETE /evenements/:id` | Événements (supprimer un événement détache ses posts, sans les supprimer) |
| `PUT /posts/:id/photo/meta`, `PUT /posts/:id/photo/linkedin` | Joint une photo (corps = image JPEG ou PNG brute, 8 Mo maximum, `Content-Type: image/jpeg` ou `image/png`) |
| `GET/DELETE /posts/:id/photo/meta`, `GET/DELETE /posts/:id/photo/linkedin` | Lit ou retire la photo (`meta` = Instagram + Facebook) |
| `GET /export.xlsx` | Export Excel : `statuts` (`valide,publie` par défaut, ou `all`), `du`, `au`, `photos=0` pour exclure les photos |
| `GET /health` | Contrôle de santé, sans jeton |

Le serveur refuse les requêtes dont l'en-tête `Origin` n'est pas son propre hôte, et celles dont le `Content-Type` n'est pas `application/json`, ce qui bloque les appels d'un autre site depuis le navigateur. La page est servie avec une politique de sécurité qui n'autorise aucune ressource externe.

## Licences

La police Atkinson Hyperlegible (Braille Institute) est intégrée à la page sous licence SIL Open Font License 1.1.
