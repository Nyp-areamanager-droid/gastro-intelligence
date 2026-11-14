-- =============================================================================
-- Migration 008: gespeicherte Dateien löschbar machen, Indizes für Abfragen
-- ENTWURF – in der Produktion NUR mit ausdrücklicher Freigabe von Redouan.
-- Voraussetzung: Migration 002 (Hilfsfunktionen und Rollenprüfung).
--
-- 1. Speicherbereich „uploads“: Inhaber und Administratoren dürfen Dateien im
--    Ordner der EIGENEN Firma löschen. Nötig für „Alle Daten löschen“ und um
--    früher gespeicherte Originaldateien (mit Namen/Telefonnummern) zu
--    entfernen. Neue Importe speichern keine Originaldatei mehr.
--    Lesen/Schreiben bleiben wie in 002 geregelt. Kein UPDATE.
-- 2. Indizes für die häufigsten Abfragen. Ändern keine Daten und keine
--    Ergebnisse, nur die Geschwindigkeit. Anlegen sperrt die Tabelle kurz
--    für Schreibzugriffe (bei den heutigen Datenmengen unter einer Sekunde).
--
-- Zweiter Lauf: ändert nichts. Rückfall: 008_rollback.sql
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.get_my_company_id()') IS NULL OR to_regprocedure('public.my_company_role()') IS NULL THEN
    RAISE EXCEPTION 'Abbruch: Migration 002 fehlt (Hilfsfunktionen nicht vorhanden). Es wurde nichts geändert.';
  END IF;
END $$;

DROP POLICY IF EXISTS "uploads_storage_delete" ON storage.objects;
CREATE POLICY "uploads_storage_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = public.get_my_company_id()::text
    AND public.my_company_role() IN ('owner', 'admin')
  );

-- Kunden einer Firma je PLZ (Karte, PLZ-Seite) und je Import (ersetzen, löschen, Übersicht)
CREATE INDEX IF NOT EXISTS customers_company_plz_idx    ON public.customers (company_id, postal_code);
CREATE INDEX IF NOT EXISTS customers_company_upload_idx ON public.customers (company_id, upload_id);
-- Neueste Auswertung je PLZ
CREATE INDEX IF NOT EXISTS analytics_company_plz_time_idx ON public.analytics (company_id, postal_code, computed_at DESC);
-- Straßen einer Auswertung (bisher nur Index auf company_id → ganze Firma wurde durchsucht)
CREATE INDEX IF NOT EXISTS street_analytics_analytics_idx ON public.street_analytics (analytics_id);
-- Offene Hinweise und Empfehlungen einer Firma
CREATE INDEX IF NOT EXISTS alerts_company_created_idx ON public.alerts (company_id, created_at DESC);
-- Fremdschlüssel ohne Index (bremst das Löschen von Importen und Auswertungen)
CREATE INDEX IF NOT EXISTS analytics_upload_idx           ON public.analytics (upload_id);
CREATE INDEX IF NOT EXISTS marketing_actions_analytics_idx ON public.marketing_actions (analytics_id);

COMMIT;

-- Kontrolle (nur lesen)
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'uploads_storage_%' ORDER BY 1;
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('customers_company_plz_idx','customers_company_upload_idx','analytics_company_plz_time_idx','street_analytics_analytics_idx','alerts_company_created_idx','analytics_upload_idx','marketing_actions_analytics_idx') ORDER BY 1;
