# Changelog — V2.5.8

## Correctif principal : animation enfin identique dans `/feed` et `/chat`

Le diagnostic runtime a montré que les cartes et canvas étaient identiques, mais pas leurs paramètres :

- `/feed` recevait notamment `orbSize=2` et `glowIntensity=0.35` ;
- `/chat` conservait encore une instance avec `orbSize=7.5` et `glowIntensity=1.10`.

La V2.5.8 supprime cette divergence :

- une configuration runtime commune est chargée avant le flux dans `/feed` et `/chat` ;
- une modification du dashboard est appliquée immédiatement aux animations déjà visibles dans **les deux vues** ;
- les paramètres URL restent la seule surcharge locale volontaire d'une Browser Source ;
- le profil visuel validé devient : 60 FPS, traînée 350 px, tour 4700 ms, orbe 7,5 px, glow 1,10, durée 25 s ;
- migration automatique du profil legacy cassé `orbSize=2 / glowIntensity=0.35` vers ce profil validé, sans écraser les autres réglages personnalisés ;
- ajout d'une révision de configuration pour que cette migration ne se répète pas.

## Nettoyage

- nouveau module `public/animation-settings.js` pour centraliser les valeurs et leur normalisation côté navigateur ;
- `/feed` et `/chat` utilisent la même fonction pour réappliquer les réglages aux cartes actives ;
- suppression du plafonnement temporaire de la traînée par ratio de périmètre : la longueur configurée est maintenant la longueur réellement utilisée ;
- suppression du `renderBoost`, devenu inutile ;
- suppression de `event-shared.css`, `_diag.html` et de l'ancien `_event-preview.html` de debug ;
- l'URL rapide du dashboard n'impose plus de paramètres d'animation cachés : elle hérite de la configuration globale ;
- documentation des valeurs par défaut corrigée.

## Robustesse de mise à jour

Le message WebSocket `hello` contient désormais la version serveur. Si une page `/feed` ou `/chat` reste ouverte pendant un changement de version, elle se recharge automatiquement à la reconnexion au lieu de continuer à exécuter un ancien frontend en mémoire.
