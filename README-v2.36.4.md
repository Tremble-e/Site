# Planilim — v2.36.4

## Liseuse PDF

- Remplacement du pilotage du lecteur PDF natif de Chrome par un rendu PDF.js dédié à la liseuse du site.
- Le document est chargé une seule fois ; les changements de page ne rechargent plus tout le PDF.
- Zoom réel de 50 % à 250 % et mode « Largeur » calculé selon la taille disponible.
- Affichage du nombre total de pages et bornage automatique du champ de page.
- Annulation du rendu précédent lorsqu'une nouvelle page ou un nouveau zoom est demandé, pour éviter les files de rendu et les ralentissements.
- Qualité HiDPI plafonnée à 2× afin de conserver un texte net sans surcharger inutilement le navigateur.
- Recalcul du mode « Largeur » lors d'un redimensionnement de la fenêtre, avec temporisation légère.
- Conservation d'un iframe natif comme solution de secours si PDF.js ne peut pas charger un document.

Aucune modification du collecteur ADE ni de la logique Filière / Salle.
