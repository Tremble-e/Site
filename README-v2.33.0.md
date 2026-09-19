# Site v2.33.0

Modifications principales :

- accès centralisé Études + Planning : compte Planilim puis validation universitaire BIOM/CAS ;
- Planning visible dans la navigation même hors connexion afin d'afficher l'activation ;
- ordre des onglets : À propos / Forum / Projets / Études / Planning / Services ;
- suppression des 3 boutons du hero, remplacés par le nombre d'EDT disponibles et la dernière synchronisation ;
- liseuse PDF intégrée au site, sans Google Docs/Drive ni autre service de visualisation tiers ;
- `supabase-university-access-v2.33.0.sql` à exécuter une fois pour le statut public et la protection RLS des tables `subjects`/`documents`.

La liseuse utilise le moteur PDF natif du navigateur à l'intérieur d'une interface contrôlée par le site. Elle ne charge aucun service de visualisation tiers.
