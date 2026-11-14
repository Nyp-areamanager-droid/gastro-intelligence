-- Rückfall zu Migration 008. NUR MIT FREIGABE ausführen.
-- Entfernt die Lösch-Regel für gespeicherte Dateien und die Indizes aus 008.
-- Ändert keine Daten. Danach kann „Alle Daten löschen“ die Dateien im Speicher
-- nicht mehr entfernen (die Datensätze in der Datenbank weiterhin).
BEGIN;
DROP POLICY IF EXISTS "uploads_storage_delete" ON storage.objects;
DROP INDEX IF EXISTS public.customers_company_plz_idx;
DROP INDEX IF EXISTS public.customers_company_upload_idx;
DROP INDEX IF EXISTS public.analytics_company_plz_time_idx;
DROP INDEX IF EXISTS public.street_analytics_analytics_idx;
DROP INDEX IF EXISTS public.alerts_company_created_idx;
DROP INDEX IF EXISTS public.analytics_upload_idx;
DROP INDEX IF EXISTS public.marketing_actions_analytics_idx;
COMMIT;
