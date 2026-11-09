-- =============================================================================
-- ENTWURF – NICHT ANWENDEN OHNE FREIGABE
-- 004: Wiederholte Uploads ohne Doppelzählung
--
-- Rein ergänzend, ändert keine Regel (RLS) und keine vorhandenen Daten:
--   - Upload-Status „replaced“ für Uploads, deren Daten ersetzt wurden
--   - uploads.file_hash: Prüfsumme der Datei, um dieselbe Datei zu erkennen
--   - uploads.import_mode: first | replace | append
-- Die bestehenden Regeln für uploads (Lesen für Mitglieder, Schreiben für
-- owner/admin/manager) gelten unverändert auch für die neuen Spalten.
--
-- Reihenfolge: VOR dem Code, der file_hash und import_mode schreibt.
-- Rückfall: siehe 004_rollback.sql
-- =============================================================================

ALTER TYPE public.upload_status ADD VALUE IF NOT EXISTS 'replaced';

BEGIN;

ALTER TABLE public.uploads ADD COLUMN IF NOT EXISTS file_hash TEXT;
ALTER TABLE public.uploads ADD COLUMN IF NOT EXISTS import_mode TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uploads_import_mode_check') THEN
    ALTER TABLE public.uploads ADD CONSTRAINT uploads_import_mode_check
      CHECK (import_mode IS NULL OR import_mode IN ('first', 'replace', 'append'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS uploads_company_file_hash_idx ON public.uploads (company_id, file_hash);

COMMIT;
