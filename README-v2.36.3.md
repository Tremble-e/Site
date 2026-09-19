# Planilim site v2.36.3

- La fenêtre de détail d’un cours conserve plus clairement la couleur du créneau d’origine.
- Les sélections « Filière » et « Salle » sont maintenant indépendantes.
- Seule la filière est enregistrée dans `user_planning_preferences`.
- La salle choisie reste temporaire pour la session courante et n’écrase plus la préférence de filière.
- Revenir sur « Filière » restaure immédiatement l’emploi du temps de filière enregistré, sans rechargement de page.
- Le cache local persistant reste réservé à la filière ; les payloads de salle ne sont utilisés qu’en mémoire.
- Aucun changement sur le collecteur ADE ou l’extension 4.16.1.
