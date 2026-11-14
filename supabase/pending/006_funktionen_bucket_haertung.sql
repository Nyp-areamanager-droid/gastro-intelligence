-- =============================================================================
-- Migration 006: Hilfsfunktionen und Upload-Speicher absichern (Nr. 10 und 12)
-- ENTWURF – in der Produktion NUR mit ausdrücklicher Freigabe von Redouan.
--
-- Was sich ändert (und nur das):
--   1. Die vier Hilfsfunktionen der Zugriffsregeln
--        get_my_company_id(), is_company_member(uuid), my_company_role(),
--        can_write_company_data() (gibt es erst ab Migration 002)
--      sind nicht mehr ohne Anmeldung (Rolle anon) aufrufbar. Angemeldete
--      Nutzer (authenticated) und der Server (service_role) behalten das Recht;
--      die Zugriffsregeln (RLS) brauchen es.
--      on_auth_user_created() (falls vorhanden; Auslöser bei neuen Konten) ist
--      danach weder ohne noch mit Anmeldung direkt aufrufbar. Als Auslöser
--      läuft sie weiter: PostgreSQL prüft das Aufrufrecht beim Auslösen nicht.
--   2. update_updated_at() bekommt einen festen, leeren Suchpfad
--      (Supabase-Warnung „Function Search Path Mutable“).
--   3. Speicherbereich „uploads“: höchstens 4 MB je Datei und nur die
--      Dateiarten, die die App annimmt (CSV/Text, Excel).
--
-- Was sich NICHT ändert: Daten, Tabellen, Zugriffsregeln (Policies), Rechte
-- auf Tabellen, andere Funktionen, register_company (schon in 003 geregelt).
--
-- Auswirkung: Ohne Anmeldung liefert eine Abfrage auf Firmentabellen künftig
-- eine Fehlermeldung statt einer leeren Liste. Die App fragt Firmendaten nur
-- angemeldet ab (Anmeldeseiten lesen keine Firmendaten).
--
-- Ablauf in EINEM Block (bei jedem Abbruch wird nichts geändert):
--   Prüfen → Ist-Zustand sichern → Sicherung prüfen → ändern → Ergebnis prüfen.
-- Zweiter Lauf: Zielzustand besteht schon → nichts zu tun.
-- Rückfall: 006_rollback.sql
-- =============================================================================
BEGIN;

CREATE SCHEMA IF NOT EXISTS migration_backup;
REVOKE ALL ON SCHEMA migration_backup FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON SCHEMA migration_backup FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON SCHEMA migration_backup FROM authenticated'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS migration_backup.m006_state (
  kind TEXT NOT NULL,          -- 'acl', 'acl_trigger', 'config', 'bucket'
  object TEXT NOT NULL,        -- Funktionssignatur bzw. Bucket-ID
  acl TEXT,                    -- Rechte vorher (pg_proc.proacl, NULL = Standard)
  config TEXT[],               -- Einstellungen vorher (pg_proc.proconfig)
  file_size_limit BIGINT,
  allowed_mime_types TEXT[],
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  helpers CONSTANT TEXT[] := ARRAY[
    'public.get_my_company_id()', 'public.is_company_member(uuid)',
    'public.my_company_role()', 'public.can_write_company_data()'];
  mimes CONSTANT TEXT[] := ARRAY[
    'text/csv', 'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.binary.macroEnabled.12'];
  size_limit CONSTANT BIGINT := 4194304;   -- 4 MB, wie MAX_UPLOAD_BYTES im Code
  trigger_fn CONSTANT TEXT := 'public.on_auth_user_created()';
  has_trigger_fn BOOLEAN := to_regprocedure('public.on_auth_user_created()') IS NOT NULL;
  f TEXT;
  present TEXT[] := ARRAY[]::TEXT[];
  n INT;
  target_reached BOOLEAN;
BEGIN
  -- ── Vorbedingungen ──────────────────────────────────────────────────────────
  FOREACH f IN ARRAY helpers LOOP
    IF to_regprocedure(f) IS NOT NULL THEN present := present || f; END IF;
  END LOOP;
  IF NOT ('public.get_my_company_id()' = ANY(present)) OR NOT ('public.is_company_member(uuid)' = ANY(present))
     OR NOT ('public.my_company_role()' = ANY(present)) THEN
    RAISE EXCEPTION 'Abbruch: Hilfsfunktionen fehlen (gefunden: %). Es wurde nichts geändert.', present;
  END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'Abbruch: update_updated_at() fehlt. Es wurde nichts geändert.';
  END IF;
  FOREACH f IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = f) THEN
      RAISE EXCEPTION 'Abbruch: Rolle % fehlt. Es wurde nichts geändert.', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uploads') THEN
    RAISE EXCEPTION 'Abbruch: Speicherbereich uploads fehlt. Es wurde nichts geändert.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets'
        AND column_name IN ('file_size_limit','allowed_mime_types')) <> 2 THEN
    RAISE EXCEPTION 'Abbruch: storage.buckets hat keine Spalten file_size_limit/allowed_mime_types. Es wurde nichts geändert.';
  END IF;

  -- ── Zielzustand schon erreicht? ─────────────────────────────────────────────
  target_reached :=
        NOT EXISTS (SELECT 1 FROM unnest(present) p WHERE has_function_privilege('anon', p, 'EXECUTE')
                                                      OR NOT has_function_privilege('authenticated', p, 'EXECUTE'))
    AND (NOT has_trigger_fn OR NOT (has_function_privilege('anon', trigger_fn, 'EXECUTE')
                                    OR has_function_privilege('authenticated', trigger_fn, 'EXECUTE')))
    AND (SELECT proconfig FROM pg_proc WHERE oid = 'public.update_updated_at()'::regprocedure) = ARRAY['search_path=""']
    AND EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uploads' AND file_size_limit = size_limit
                AND allowed_mime_types::text[] @> mimes AND mimes @> allowed_mime_types::text[]);

  SELECT count(*) INTO n FROM migration_backup.m006_state;
  IF n > 0 THEN
    IF NOT target_reached THEN
      RAISE EXCEPTION 'Abbruch: Eine Sicherung von einem früheren Lauf existiert, aber der Zustand weicht vom Ziel ab. Bitte zuerst prüfen. Es wurde nichts geändert.';
    END IF;
    RAISE NOTICE 'Zielzustand besteht bereits, Sicherung vorhanden. Nichts zu tun.';
    RETURN;
  END IF;

  -- ── Ist-Zustand sichern ─────────────────────────────────────────────────────
  INSERT INTO migration_backup.m006_state (kind, object, acl)
    SELECT 'acl', p, (SELECT proacl::text FROM pg_proc WHERE oid = p::regprocedure) FROM unnest(present) p;
  IF has_trigger_fn THEN
    INSERT INTO migration_backup.m006_state (kind, object, acl)
      SELECT 'acl_trigger', trigger_fn, proacl::text FROM pg_proc WHERE oid = trigger_fn::regprocedure;
  END IF;
  INSERT INTO migration_backup.m006_state (kind, object, config)
    SELECT 'config', 'public.update_updated_at()', proconfig FROM pg_proc WHERE oid = 'public.update_updated_at()'::regprocedure;
  INSERT INTO migration_backup.m006_state (kind, object, file_size_limit, allowed_mime_types)
    SELECT 'bucket', id, file_size_limit, allowed_mime_types::text[] FROM storage.buckets WHERE id = 'uploads';

  -- ── Sicherung prüfen, BEVOR etwas geändert wird ─────────────────────────────
  IF (SELECT count(*) FROM migration_backup.m006_state WHERE kind = 'acl') <> cardinality(present)
     OR (SELECT count(*) FROM migration_backup.m006_state WHERE kind = 'acl_trigger') <> has_trigger_fn::int
     OR EXISTS (SELECT 1 FROM migration_backup.m006_state b JOIN pg_proc p ON p.oid = b.object::regprocedure
                WHERE b.kind IN ('acl', 'acl_trigger') AND b.acl IS DISTINCT FROM p.proacl::text)
     OR (SELECT count(*) FROM migration_backup.m006_state WHERE kind = 'config') <> 1
     OR (SELECT config FROM migration_backup.m006_state WHERE kind = 'config')
          IS DISTINCT FROM (SELECT proconfig FROM pg_proc WHERE oid = 'public.update_updated_at()'::regprocedure)
     OR (SELECT count(*) FROM migration_backup.m006_state WHERE kind = 'bucket') <> 1
     OR EXISTS (SELECT 1 FROM migration_backup.m006_state b JOIN storage.buckets k ON k.id = b.object
                WHERE b.kind = 'bucket' AND (b.file_size_limit IS DISTINCT FROM k.file_size_limit
                                             OR b.allowed_mime_types IS DISTINCT FROM k.allowed_mime_types::text[])) THEN
    RAISE EXCEPTION 'Abbruch: Sicherung unvollständig oder abweichend. Es wurde nichts geändert.';
  END IF;

  -- ── Ändern ──────────────────────────────────────────────────────────────────
  FOREACH f IN ARRAY present LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
  IF has_trigger_fn THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', trigger_fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', trigger_fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', trigger_fn);
  END IF;
  EXECUTE 'ALTER FUNCTION public.update_updated_at() SET search_path = ''''';
  UPDATE storage.buckets SET file_size_limit = size_limit, allowed_mime_types = mimes WHERE id = 'uploads';

  -- ── Ergebnis prüfen ─────────────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM unnest(present) p WHERE has_function_privilege('anon', p, 'EXECUTE')
                                               OR NOT has_function_privilege('authenticated', p, 'EXECUTE'))
     OR (has_trigger_fn AND (has_function_privilege('anon', trigger_fn, 'EXECUTE')
                             OR has_function_privilege('authenticated', trigger_fn, 'EXECUTE')))
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public.update_updated_at()'::regprocedure) IS DISTINCT FROM ARRAY['search_path=""']
     OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uploads' AND file_size_limit = size_limit) THEN
    RAISE EXCEPTION 'Abbruch: Zielzustand nicht erreicht. Es wurde nichts geändert.';
  END IF;
END $$;

COMMIT;

-- Kontrolle (nur lesen)
SELECT p.oid::regprocedure AS funktion,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS ohne_anmeldung,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS angemeldet,
       p.proconfig AS einstellungen
FROM pg_proc p
WHERE p.oid IN (SELECT to_regprocedure(x) FROM unnest(ARRAY['public.get_my_company_id()','public.is_company_member(uuid)',
                'public.my_company_role()','public.can_write_company_data()','public.update_updated_at()',
                'public.on_auth_user_created()']) x)
ORDER BY 1;
SELECT id, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'uploads';
