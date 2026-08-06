# Rafraîchissement automatique dans le service Power BI

Objectif : après publication du rapport, le **service Power BI** rafraîchit seul
les données Pennylane / Sellsy / Monday selon une planification (ex. tous les
matins à 7 h).

## 1. Principe : des paramètres, pas de clés en dur

Aucune clé n'est écrite dans les requêtes. Toutes passent par des **paramètres**
(*Accueil > Gérer les paramètres*) :

| Paramètre              | Type   | Exemple / rôle                          |
|------------------------|--------|-----------------------------------------|
| `pPennylaneApiKey`     | Texte  | clé API Pennylane (Bearer)              |
| `pSellsyClientId`      | Texte  | client_id de l'app Sellsy               |
| `pSellsyClientSecret`  | Texte  | client_secret de l'app Sellsy           |
| `pMondayToken`         | Texte  | jeton API personnel Monday              |
| `pMondayBoardId`       | Texte  | ID du tableau de suivi des factures     |
| `pAnneeDebut`          | Nombre | année de départ du calendrier (ex 2023) |

> Où trouver les clés :
> - **Pennylane** : *Paramètres > API & webhooks* → clé Bearer.
> - **Sellsy** : *Paramètres > API v2* → créer une application OAuth2
>   (client_credentials) → client_id + client_secret.
> - **Monday** : *avatar > Développeurs (Developers) > My access tokens*, ou
>   *Admin > API*. L'ID du tableau est dans l'URL : `.../boards/1234567890`.

## 2. Pourquoi le motif `Web.Contents(BaseUrl, [RelativePath=…])`

Le service Power BI n'autorise le refresh planifié que s'il peut **identifier
une source stable**. C'est pourquoi les connecteurs utilisent
`Web.Contents("https://…", [RelativePath=…, Query=…, Headers=…])` et **jamais**
une URL concaténée dynamiquement. Gardez ce motif si vous modifiez le code.

## 3. Authentification des sources (dans le service)

Après publication : *Paramètres du jeu de données > Informations
d'identification de la source de données*.

| Source (BaseUrl)              | Méthode à choisir | Remarque |
|-------------------------------|-------------------|----------|
| `app.pennylane.com`           | **Anonyme**       | La clé transite via l'en-tête `Authorization` (paramètre). |
| `api.monday.com`              | **Anonyme**       | Le jeton transite via l'en-tête `Authorization`. |
| `login.sellsy.com` + `api.sellsy.com` | **Anonyme** | Le secret transite via le POST du token OAuth. |

> ⚠️ **Niveau de confidentialité** : réglez chaque source sur `Organizational`
> (ou `Public`) de façon **cohérente**. Un mélange `Private`/`Public` fait
> échouer le refresh avec l'erreur *« Formula.Firewall »*. En cas d'erreur
> firewall persistante liée à l'échange de token Sellsy, cochez *« Ignorer les
> niveaux de confidentialité »* dans les paramètres du jeu de données.

## 4. Passerelle (gateway) : nécessaire ?

Les 3 API sont **dans le cloud** → en général **aucune passerelle On-premises
n'est requise** ; le service accède directement aux URLs.

Cas où une **passerelle (mode VNet ou On-premises)** peut devenir nécessaire :

- L'échange de token OAuth de Sellsy (source « dynamique ») est parfois refusé
  par le refresh natif. Si le refresh échoue **uniquement** sur Sellsy avec un
  message de source dynamique, deux options :
  1. installer une **passerelle de données** et y déclarer les sources, ou
  2. remplacer le connecteur Sellsy par un **connecteur personnalisé**
     (.mez) gérant l'OAuth proprement.
- Pennylane et Monday (clé statique en en-tête) fonctionnent normalement
  **sans** passerelle.

## 5. Planifier le rafraîchissement

1. Publier le rapport : *Power BI Desktop > Publier* → choisir l'espace de travail.
2. Dans le service : *Espace de travail > le jeu de données > ⚙ Paramètres*.
3. **Informations d'identification** : renseigner chaque source (voir §3).
4. **Actualisation planifiée** : activer, choisir la fréquence (ex. quotidienne
   07 h), le fuseau (Europe/Paris) et une adresse de notification d'échec.
5. Lancer un *Actualiser maintenant* pour valider.

## 6. Sécurité des secrets

- Les valeurs des paramètres sont stockées **chiffrées** dans le jeu de données
  publié ; elles ne sont pas visibles dans le rapport.
- Restreignez le partage du jeu de données aux personnes autorisées.
- En cas de rotation d'une clé : *Paramètres du jeu de données > modifier le
  paramètre* (ou republier), pas besoin de retoucher les requêtes.

## 7. Dépannage rapide

| Symptôme | Piste |
|----------|-------|
| Erreur *Formula.Firewall* au refresh | Aligner les niveaux de confidentialité (§3) ou cocher « Ignorer ». |
| Refresh Sellsy KO (« dynamic data source ») | Passerelle ou connecteur personnalisé (§4). |
| 401 / 403 | Clé expirée ou scope OAuth insuffisant ; régénérer le token. |
| Champs vides (Pennylane) | Noms de champs API différents : ajuster le bloc `Expand` du .pq. |
| Colonnes Monday manquantes | Titres de colonnes ≠ ceux listés dans `ColonnesVoulues`. |
| Balance âgée figée | Vérifier que le refresh planifié tourne (TODAY() = date du refresh). |
