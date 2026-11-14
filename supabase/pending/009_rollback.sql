-- =============================================================================
-- Rückfall zu Migration 009. NUR MIT FREIGABE ausführen.
-- Entfernt Straßenverzeichnis und Ortstabelle und die in 009 angelegten Spalten.
-- Verloren gehen dabei nur abgeleitete Werte (Zuordnungsstatus je Kunde,
-- Zusammenfassung je Import, Qualitätsvermerke) – sie entstehen beim nächsten
-- Import bzw. Laden der Referenzdaten neu. Einwohner- und Haushaltszahlen in
-- postal_codes bleiben stehen (Spalten aus 005).
-- =============================================================================
BEGIN;
DROP TABLE IF EXISTS public.street_directory;
DROP TABLE IF EXISTS public.plz_localities;
ALTER TABLE public.postal_codes DROP CONSTRAINT IF EXISTS postal_codes_population_quality_check;
ALTER TABLE public.postal_codes DROP CONSTRAINT IF EXISTS postal_codes_households_quality_check;
ALTER TABLE public.postal_codes DROP COLUMN IF EXISTS ags;
ALTER TABLE public.postal_codes DROP COLUMN IF EXISTS population_quality;
ALTER TABLE public.postal_codes DROP COLUMN IF EXISTS households_quality;
ALTER TABLE public.postal_codes DROP COLUMN IF EXISTS reference_version;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_geo_status_check;
ALTER TABLE public.customers DROP COLUMN IF EXISTS geo_status;
ALTER TABLE public.uploads DROP COLUMN IF EXISTS geo_summary;
COMMIT;
