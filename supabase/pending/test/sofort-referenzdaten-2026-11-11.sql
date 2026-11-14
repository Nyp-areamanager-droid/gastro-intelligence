-- =============================================================================
-- ENTWURF – NUR MIT FREIGABE VON REDOUAN IN DER PRODUKTION AUSFÜHREN
-- Sofortmaßnahme: RLS für die gemeinsamen Referenzdaten einschalten
-- Fassung 3 (11.11.2026): mit Prüfung der Sicherung vor jeder Änderung;
--   CREATE POLICY im DO-Block einheitlich über EXECUTE
--
-- Betrifft NUR diese vier Tabellen (keine Kunden- oder Firmendaten):
--   postal_codes, streets, poi_businesses, data_refresh_logs
-- Ändert keine Daten, keine Rechte (GRANT), keine anderen Tabellen,
-- Funktionen oder Trigger.
--
-- Ablauf (alles in EINEM Block; bei jedem Abbruch wird nichts geändert):
--   1. Prüfen, dass alle vier Tabellen vorhanden sind.
--   2. Ist-Zustand sichern (RLS an/aus und alle Regeln der vier Tabellen)
--      in migration_backup.sofort_ref_state.
--   3. Sicherung prüfen: für jede der vier Tabellen genau ein RLS-Eintrag,
--      Regeln vollständig und identisch mit dem Ist-Zustand. Sonst Abbruch.
--   4. Erst dann ändern: alte Regeln der vier Tabellen entfernen, RLS an,
--      Lesen nur für angemeldete Nutzer.
--   5. Ergebnis prüfen. Sonst Abbruch.
-- Zweiter Lauf: Ist der Zielzustand schon erreicht und die Sicherung
-- vollständig, passiert nichts. Weicht der Zustand vom Ziel ab, obwohl eine
-- Sicherung existiert, bricht das Skript ab (die Sicherung wäre dann nicht
-- mehr der Zustand unmittelbar vor der Maßnahme).
-- Rückfall: 4_rueckfall_sofort.sql
-- =============================================================================
BEGIN;

CREATE SCHEMA IF NOT EXISTS migration_backup;
REVOKE ALL ON SCHEMA migration_backup FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON SCHEMA migration_backup FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON SCHEMA migration_backup FROM authenticated'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS migration_backup.sofort_ref_state (
  kind TEXT NOT NULL,            -- 'rls' oder 'policy'
  tablename TEXT NOT NULL,
  rls_enabled BOOLEAN,
  policyname TEXT, permissive TEXT, roles TEXT[], cmd TEXT, qual TEXT, with_check TEXT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  tabs CONSTANT TEXT[] := ARRAY['postal_codes','streets','poi_businesses','data_refresh_logs'];
  t TEXT;
  n_backup INT;
  n_rls INT;
  n_pol_backup INT;
  n_pol_now INT;
  target_reached BOOLEAN;
BEGIN
  -- 1. Alle vier Tabellen müssen vorhanden sein
  FOREACH t IN ARRAY tabs LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'Abbruch: Tabelle public.% fehlt. Es wurde nichts geändert.', t;
    END IF;
  END LOOP;

  -- Zielzustand schon erreicht? (RLS an überall, genau die drei Leseregeln)
  target_reached :=
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY(tabs) AND c.relrowsecurity) = 4
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY(tabs)) = 3
    AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
          AND (tablename, policyname) IN (('postal_codes','postal_codes_select'),('streets','streets_select'),('poi_businesses','poi_businesses_select'))
          AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[] AND qual = 'true') = 3;

  SELECT count(*) INTO n_backup FROM migration_backup.sofort_ref_state;

  IF n_backup > 0 THEN
    -- Es gibt schon eine Sicherung: nur zulässig, wenn der Zielzustand besteht
    SELECT count(DISTINCT tablename) INTO n_rls FROM migration_backup.sofort_ref_state
      WHERE kind = 'rls' AND tablename = ANY(tabs);
    IF n_rls <> 4 OR (SELECT count(*) FROM migration_backup.sofort_ref_state WHERE kind = 'rls') <> 4 THEN
      RAISE EXCEPTION 'Abbruch: Vorhandene Sicherung ist unvollständig (% von 4 Tabellen). Es wurde nichts geändert.', n_rls;
    END IF;
    IF NOT target_reached THEN
      RAISE EXCEPTION 'Abbruch: Eine Sicherung von einem früheren Lauf existiert, aber der aktuelle Zustand weicht vom Ziel ab. Bitte zuerst prüfen bzw. den Rückfall ausführen. Es wurde nichts geändert.';
    END IF;
    RAISE NOTICE 'Zielzustand besteht bereits, Sicherung vollständig. Nichts zu tun.';
    RETURN;
  END IF;

  -- 2. Ist-Zustand sichern
  INSERT INTO migration_backup.sofort_ref_state (kind, tablename, rls_enabled)
    SELECT 'rls', c.relname, c.relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY(tabs);
  INSERT INTO migration_backup.sofort_ref_state (kind, tablename, policyname, permissive, roles, cmd, qual, with_check)
    SELECT 'policy', tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = ANY(tabs);

  -- 3. Sicherung prüfen, BEVOR etwas geändert wird
  FOREACH t IN ARRAY tabs LOOP
    IF (SELECT count(*) FROM migration_backup.sofort_ref_state WHERE kind = 'rls' AND tablename = t) <> 1 THEN
      RAISE EXCEPTION 'Abbruch: RLS-Zustand von % nicht gesichert. Es wurde nichts geändert.', t;
    END IF;
    IF (SELECT b.rls_enabled FROM migration_backup.sofort_ref_state b WHERE b.kind = 'rls' AND b.tablename = t)
       IS DISTINCT FROM
       (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'Abbruch: Gesicherter RLS-Zustand von % stimmt nicht mit dem Ist-Zustand überein. Es wurde nichts geändert.', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO n_pol_backup FROM migration_backup.sofort_ref_state WHERE kind = 'policy';
  SELECT count(*) INTO n_pol_now FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY(tabs);
  IF n_pol_backup <> n_pol_now OR EXISTS (
       SELECT tablename, policyname, permissive, roles::text[], cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY(tabs)
       EXCEPT
       SELECT tablename, policyname, permissive, roles, cmd, qual, with_check FROM migration_backup.sofort_ref_state
        WHERE kind = 'policy') THEN
    RAISE EXCEPTION 'Abbruch: Regeln nicht vollständig gesichert (% gesichert, % vorhanden). Es wurde nichts geändert.', n_pol_backup, n_pol_now;
  END IF;

  -- 4. Erst jetzt ändern
  FOR t IN SELECT format('DROP POLICY %I ON public.%I', policyname, tablename) FROM pg_policies
           WHERE schemaname = 'public' AND tablename = ANY(tabs)
  LOOP
    EXECUTE t;
  END LOOP;
  FOREACH t IN ARRAY tabs LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  EXECUTE 'CREATE POLICY "postal_codes_select"   ON public.postal_codes   FOR SELECT TO authenticated USING (true)';
  EXECUTE 'CREATE POLICY "streets_select"        ON public.streets        FOR SELECT TO authenticated USING (true)';
  EXECUTE 'CREATE POLICY "poi_businesses_select" ON public.poi_businesses FOR SELECT TO authenticated USING (true)';
  -- data_refresh_logs: keine Regel → nur der Server (Service-Key)

  -- 5. Ergebnis prüfen
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY(tabs) AND c.relrowsecurity) <> 4
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY(tabs)) <> 3 THEN
    RAISE EXCEPTION 'Abbruch: Zielzustand nicht erreicht. Es wurde nichts geändert.';
  END IF;
END $$;

COMMIT;

-- Kontrolle (nur lesen): vier Zeilen, alle rls = true; gesichert = Zustand vorher
SELECT c.relname AS tabelle, c.relrowsecurity AS rls,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS regeln,
       (SELECT b.rls_enabled FROM migration_backup.sofort_ref_state b WHERE b.kind = 'rls' AND b.tablename = c.relname) AS rls_vorher_gesichert
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('postal_codes','streets','poi_businesses','data_refresh_logs')
ORDER BY 1;
