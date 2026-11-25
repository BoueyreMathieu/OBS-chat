# OBS Chat Overlay — Prototype V2.5.8

Application locale Twitch + YouTube pour afficher le chat dans OBS via Browser Source et disposer d'une console `/chat` persistante pendant la session du serveur.

## Lancement

Windows : `start-windows.bat`

- Dashboard : `http://127.0.0.1:4242/`
- Console : `http://127.0.0.1:4242/chat`
- Feed OBS : `http://127.0.0.1:4242/overlay/feed`
- Feed persistant : `http://127.0.0.1:4242/overlay/feed?persist=1&limit=8`

Node.js 20+ est requis.

## V2.5.8 — correction de la configuration des animations

Le problème de différence visuelle entre `/feed` et `/chat` venait d'une divergence de **paramètres runtime**, pas du CSS ni de la taille des cartes.

Les mesures ont montré une carte identique (980×45 px) et un canvas identique (1044×109 px), mais :

- `/feed` : orbe 2 px, glow 0,35 ;
- `/chat` : orbe 7,5 px, glow 1,10.

La V2.5.8 utilise désormais le même chemin de configuration et le même mécanisme de mise à jour dans les deux vues.

### Profil visuel de référence

- FPS : 60
- traînée : 350 px
- tour complet : 4700 ms
- orbe : 7,5 px
- glow : 1,10
- durée : 25 000 ms

Ces valeurs correspondent au rendu `/chat` validé pendant le diagnostic.

Au premier démarrage, si `data/config.json` contient précisément l'ancien profil cassé avec orbe 2 px et glow 0,35, il est migré automatiquement vers le profil ci-dessus. Les autres réglages personnalisés sont conservés.

## Architecture de rendu

`/feed` et `/chat` utilisent tous les deux :

- `message-card.js` pour construire la carte ;
- `message-card.css` pour son rendu ;
- `event-glow-lite.js` pour le canvas ;
- `animation-settings.js` pour les réglages navigateur.

Les différences de page restent autour de la carte :

- `/feed` : filtres, limite visible, disparition automatique, `persist=1` ;
- `/chat` : historique de session, timestamp, scroll, composer.

Une sauvegarde des sliders dans le dashboard est diffusée immédiatement aux deux vues et met à jour les events encore animés sans leur redonner artificiellement 25 secondes.

## Surcharges URL

Une Browser Source peut volontairement surcharger la configuration globale :

- `eventFps=60`
- `trailLength=350`
- `orbitDuration=4700`
- `orbSize=7.5`
- `glowIntensity=1.10`
- `eventDuration=25000`

Priorité : **URL > dashboard/config > profil intégré**.

Exemple :

`/overlay/feed?platform=twitch&events=chat,sub,resub,gift,reward`

L'URL rapide affichée par le dashboard ne force plus de paramètres d'animation, afin d'éviter une divergence silencieuse avec la configuration globale.

## Autres fonctions conservées

- Twitch + YouTube live chat ;
- badges Twitch et emotes ;
- noms publics YouTube avec cache ;
- sub/resub/gifts ;
- Channel Points rewards statiques ;
- Bits/Cheers avec halo pulsant ;
- événements enrichis YouTube ;
- premiers messages Twitch du live / de la chaîne ;
- envoi depuis `/chat` et le dashboard via cases Twitch / YouTube / Les deux ;
- filtres `platform=` et `events=` ;
- `animations=0` pour couper les animations spéciales ;
- aperçu dashboard désactivable pour économiser les ressources.

## Configuration et secrets

`data/config.json` est créé localement et n'est pas inclus dans le ZIP de release. Les identifiants/tokens existants peuvent donc être conservés lors d'une mise à jour.

Les secrets sont encore stockés en clair sur le disque dans ce prototype ; un packaging futur devra utiliser le stockage sécurisé du système.
