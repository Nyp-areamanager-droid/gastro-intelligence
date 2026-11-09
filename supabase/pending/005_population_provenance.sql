-- =============================================================================
-- ENTWURF – NICHT ANWENDEN OHNE FREIGABE
-- 005: Herkunft der Einwohner- und Haushaltszahlen
--
-- Rein ergänzend, ändert keine Regel (RLS) und keine vorhandenen Daten.
--   - postal_codes.population_method: wie die Zahl entstanden ist
--     (z. B. 'zensus2022_gitter100m_plz_osm'). Die App verwendet Einwohner
--     und Haushalte NUR, wenn dieses Feld gesetzt ist.
--   - postal_codes.population_reference_date: Stichtag der Quelle
-- Ältere Einträge (aus den früher eingebauten, unbelegten Tabellen) bleiben
-- unverändert stehen, werden aber nicht mehr angezeigt.
--
-- Optional, nur mit Freigabe: alte unbelegte Werte entfernen
--   UPDATE public.postal_codes SET population = NULL, households = NULL,
--     population_source = NULL, population_year = NULL
--   WHERE population_method IS NULL AND population IS NOT NULL;
--
-- Rückfall: 005_rollback.sql
-- =============================================================================

BEGIN;
ALTER TABLE public.postal_codes ADD COLUMN IF NOT EXISTS population_method TEXT;
ALTER TABLE public.postal_codes ADD COLUMN IF NOT EXISTS population_reference_date DATE;
COMMIT;
