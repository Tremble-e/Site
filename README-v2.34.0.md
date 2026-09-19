# Site Planilim v2.34.0

Cette version reprend la v2.33.0 et ajoute la protection complète des documents d'Études stockés dans Supabase :

- `course-files` passe en bucket privé ;
- lecture réservée aux comptes Planilim ayant validé BIOM/CAS (ou admin) ;
- les URL publiques historiques des fichiers gérés par Supabase sont remplacées en base par des références internes `storage://...` ;
- le navigateur génère une URL signée temporaire uniquement lorsque l'utilisateur ouvre ou télécharge un document ;
- le bouton **Télécharger** effectue un vrai téléchargement `fetch -> Blob -> fichier local`, au lieu de simplement ouvrir le document ;
- un bouton de téléchargement direct est ajouté à côté de chaque ressource d'Études ;
- la liseuse PDF intégrée est conservée ;
- l'accès Études + Planning reste centralisé derrière compte Planilim + activation BIOM.

## Installation

1. Déployer les fichiers du site v2.34.0.
2. Exécuter une seule fois `supabase-university-access-v2.34.0.sql` dans l'éditeur SQL Supabase.
3. Vérifier dans Supabase Storage que le bucket `course-files` apparaît bien comme **Private**.
4. Tester avec : visiteur non connecté, compte connecté non BIOM, compte BIOM validé, compte admin.

Les documents référencés par une URL externe hors Supabase ne peuvent pas être rendus privés par les politiques Supabase. Pour une protection complète, importer ces fichiers dans Planilim afin qu'ils aient un `storage_path` dans `course-files`.
