# Planilim v2.36.0

Cette version ajoute la synchronisation et la consultation des emplois du temps de salles, sans modifier le moteur de récupération hebdomadaire stabilisé.

## Emplois du temps

- choix `Filière` / `Salle` dans le sélecteur ;
- pour les salles : `Bâtiment` puis `Salle` ;
- périmètre ADE salles : `Salles > LIMOGES > LIMOGES La Borie FST` ;
- les ressources partagées continuent d'utiliser la table existante, sans migration SQL.

## Administration ADE

- synchroniser les filières ;
- synchroniser les salles ;
- synchroniser les deux, séquentiellement ;
- relancer séparément les échecs filières, salles ou tous les échecs ;
- les libellés du collecteur ont été uniformisés pour rester neutres et adaptés à un usage partagé.

## Extension

Le paquet distribué par le site est `planilim-collector-v4.16.0.zip`.

### Supabase

Aucune nouvelle table n'est nécessaire. Le fichier `supabase-planning-rooms-v2.36.0.sql` met uniquement à jour le compteur public de la page d'accueil pour inclure les salles en plus des filières.
