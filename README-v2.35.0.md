# Site Planilim v2.35.0

Cette version reprend intégralement la v2.34.0 (accès BIOM centralisé, bucket `course-files` privé, URL signées, vrai téléchargement local et liseuse PDF intégrée) et modifie l'accueil :

- les quatre indicateurs sont regroupés dans une grille 2 × 2 ;
- ligne 1 : **Projets** / **Documents d’étude** ;
- ligne 2 : **Emplois du temps** / **Services** ;
- le statut Planning utilise maintenant exactement la même famille de carte que les trois autres indicateurs ;
- la carte Planning conserve le nombre d’EDT et la date/heure de dernière synchronisation ;
- le téléchargement proposé pour l’extension pointe vers Planilim Collector v4.15.0.

Si la migration de sécurité v2.34.0 n’a pas encore été exécutée, utiliser `supabase-university-access-v2.34.0.sql` inclus dans l’archive. Aucune nouvelle migration SQL n’est nécessaire pour la v2.35.0.
