-- =============================================================================
-- ENTWURF – NICHT ANWENDEN OHNE FREIGABE
-- 002: Mandantentrennung, Rollenrechte, Referenzdaten, Storage
--
-- Liegt bewusst NICHT in supabase/migrations/, damit `supabase db push`
-- ihn nicht versehentlich ausführt.
--
-- Stand 06.11.2026 (Fassung 2), abgeglichen mit der Lese-Abfrage in Produktion:
--   Produktion entspricht keiner Schemadatei exakt. Sie enthält u. a. die
--   von Hand angelegte Regel company_users_insert_own (jeder eingeloggte
--   Nutzer kann sich als owner in JEDE Firma eintragen). Fassung 1 hat
--   Regeln nur über bekannte Namen gelöscht und hätte diese Lücke offen
--   gelassen. Fassung 2 entfernt ALLE Regeln der betroffenen Tabellen und
--   legt den vollständigen neuen Satz an.
--
-- Sicherung und Rückfall:
--   Vor jeder Änderung wird der exakte Ist-Zustand (Regeln, Hilfsfunktionen,
--   RLS an/aus, Bucket-Einstellung) im Schema migration_backup gespeichert.
--   002_rollback.sql stellt genau diesen Zustand wieder her. Die Sicherung
--   wird nur beim ersten Lauf geschrieben; ein zweiter Lauf überschreibt sie
--   nicht.
--
-- Daten: Diese Migration ändert keine einzige Datenzeile in den App-Tabellen.
--   Ausnahme: storage.buckets.public für 'uploads' wird auf FALSE gesetzt
--   (ist in Produktion bereits privat).
--
-- Voraussetzungen vor dem Anwenden:
--   1. Phase-0-Code ist deployed (Registrierung über
--      /api/auth/complete-registration). Ohne ihn schlägt die Registrierung
--      nach dieser Migration fehl.
--   2. Alle Nutzer, die Daten hochladen, haben die Rolle owner, admin oder
--      manager (check_before_migration.sql, Teil A).
--   3. Zuerst in einem Testprojekt mit Produktionsstand angewendet und mit
--      supabase/pending/migration-test.mjs geprüft.
--
-- Die Server-Routen nutzen den Service-Key und sind von RLS nicht betroffen.
-- Alles läuft in EINER Transaktion: Schlägt ein Schritt fehl, bleibt der
-- alte Zustand vollständig erhalten.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 0a. Ist-Zustand sichern (nur beim ersten Lauf)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS migration_backup;
REVOKE ALL ON SCHEMA migration_backup FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA migration_backup FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA migration_backup FROM authenticated';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS migration_backup.m002_state (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,        -- policy | function | rls | bucket
  object      TEXT NOT NULL,
  statement   TEXT,                 -- exakter Befehl zum Wiederherstellen
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON migration_backup.m002_state FROM PUBLIC;

DO $$
DECLARE
  app_tables TEXT[] := ARRAY['companies','company_users','stores','uploads','customers',
                             'analytics','street_analytics','marketing_actions','alerts',
                             'postal_codes','streets','poi_businesses','data_refresh_logs'];
BEGIN
  IF EXISTS (SELECT 1 FROM migration_backup.m002_state) THEN
    RAISE NOTICE 'Sicherung vorhanden (frühere Ausführung) – wird nicht überschrieben';
    RETURN;
  END IF;

  -- Regeln, exakt als CREATE POLICY rekonstruiert
  INSERT INTO migration_backup.m002_state (kind, object, statement)
  SELECT 'policy',
         p.schemaname || '.' || p.tablename || '.' || p.policyname,
         format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
                p.policyname, p.schemaname, p.tablename, p.permissive, p.cmd,
                array_to_string(ARRAY(
                  SELECT CASE WHEN r = 'public' THEN 'public' ELSE quote_ident(r) END
                  FROM unnest(p.roles) AS r), ', '),
                CASE WHEN p.qual IS NOT NULL THEN ' USING (' || p.qual || ')' ELSE '' END,
                CASE WHEN p.with_check IS NOT NULL THEN ' WITH CHECK (' || p.with_check || ')' ELSE '' END)
  FROM pg_policies p
  WHERE (p.schemaname = 'public' AND p.tablename = ANY (app_tables))
     OR (p.schemaname = 'storage' AND p.tablename = 'objects'
         AND (coalesce(p.qual, '') LIKE '%uploads%' OR coalesce(p.with_check, '') LIKE '%uploads%'));

  -- Hilfsfunktionen, exakt wie sie heute definiert sind
  INSERT INTO migration_backup.m002_state (kind, object, statement)
  SELECT 'function', p.proname, pg_get_functiondef(p.oid)
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('get_my_company_id', 'is_company_member', 'my_company_role',
                      'can_write_company_data', 'on_auth_user_created');

  -- RLS an/aus je Tabelle
  INSERT INTO migration_backup.m002_state (kind, object, statement)
  SELECT 'rls', c.relname,
         format('ALTER TABLE public.%I %s ROW LEVEL SECURITY', c.relname,
                CASE WHEN c.relrowsecurity THEN 'ENABLE' ELSE 'DISABLE' END)
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
    AND c.relname = ANY (app_tables);

  -- Bucket-Einstellung
  INSERT INTO migration_backup.m002_state (kind, object, statement)
  SELECT 'bucket', b.id,
         format('UPDATE storage.buckets SET public = %L::boolean WHERE id = %L', b.public, b.id)
  FROM storage.buckets b WHERE b.id = 'uploads';

  -- Marker: Sicherung vollständig
  INSERT INTO migration_backup.m002_state (kind, object, statement)
  VALUES ('marker', 'complete', NULL);
END $$;

-- =============================================================================
-- 0b. ALLE vorhandenen Regeln der betroffenen Tabellen entfernen
-- =============================================================================
-- Regeln wirken zusammen: Bleibt eine offene Regel stehen (z. B. die von
-- Hand angelegte company_users_insert_own), hilft keine neue. Deshalb wird
-- nicht nach Namen gelöscht, sondern alles auf diesen Tabellen. Die
-- Abschnitte unten legen den vollständigen neuen Satz an.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('companies','company_users','stores','uploads','customers',
                        'analytics','street_analytics','marketing_actions','alerts',
                        'postal_codes','streets','poi_businesses','data_refresh_logs')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;

  -- Storage: nur Regeln, die den Bucket 'uploads' betreffen
  FOR r IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND (coalesce(qual,'') LIKE '%uploads%' OR coalesce(with_check,'') LIKE '%uploads%')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- =============================================================================
-- 1. Hilfsfunktionen härten
-- =============================================================================
-- Probleme vorher:
--   - SECURITY DEFINER ohne festen search_path: Ein Angreifer mit
--     Schreibrecht auf ein Schema im Suchpfad könnte Objekte unterschieben.
--   - get_my_company_id(): LIMIT 1 ohne ORDER BY, bei mehreren Firmen
--     zufälliges Ergebnis.
--   - my_company_role(): lieferte die BESTE Rolle über ALLE Firmen des
--     Nutzers, nicht die Rolle in der Firma aus get_my_company_id(). Owner in
--     Firma A und viewer in Firma B hätte in B Owner-Rechte bekommen.

CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT company_id FROM public.company_users
  WHERE user_id = auth.uid()
  ORDER BY joined_at ASC, company_id ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_company_member(cid UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_users
    WHERE user_id = auth.uid() AND company_id = cid
  );
$$;

CREATE OR REPLACE FUNCTION public.my_company_role()
RETURNS public.user_role
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT role FROM public.company_users
  WHERE user_id = auth.uid()
    AND company_id = public.get_my_company_id()
  LIMIT 1;
$$;

-- Rollenmodell (gleich wie im Code, src/lib/auth/company-context.ts):
--   owner, admin : alles inkl. Mitglieder und Firmeneinstellungen
--   manager      : Daten importieren und ändern
--   viewer       : nur lesen
CREATE OR REPLACE FUNCTION public.can_write_company_data()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(public.my_company_role() IN ('owner', 'admin', 'manager'), FALSE);
$$;

-- on_auth_user_created: Inhalt NICHT ersetzen (was die Funktion in Produktion
-- tut, ist nicht sicher bekannt). Nur den festen Suchpfad setzen, falls es sie gibt.
DO $$
BEGIN
  IF to_regprocedure('public.on_auth_user_created()') IS NOT NULL THEN
    ALTER FUNCTION public.on_auth_user_created() SET search_path = public, pg_temp;
  END IF;
END $$;

-- =============================================================================
-- 2. companies
-- =============================================================================
-- Vorher in SETUP_DATABASE.sql: companies_insert WITH CHECK (TRUE)
DROP POLICY IF EXISTS "companies_insert" ON public.companies;

DROP POLICY IF EXISTS "companies_select" ON public.companies;
CREATE POLICY "companies_select" ON public.companies FOR SELECT
  USING (public.is_company_member(id));

-- Vorher in SETUP_DATABASE.sql: Update für jedes Mitglied (auch viewer)
DROP POLICY IF EXISTS "companies_update" ON public.companies;
CREATE POLICY "companies_update" ON public.companies FOR UPDATE
  USING (public.is_company_member(id) AND public.my_company_role() IN ('owner', 'admin'))
  WITH CHECK (public.is_company_member(id) AND public.my_company_role() IN ('owner', 'admin'));
-- Kein INSERT, kein DELETE aus dem Browser: nur über Server-Routen.

-- =============================================================================
-- 3. company_users
-- =============================================================================
-- Vorher in SETUP_DATABASE.sql: company_users_insert WITH CHECK (TRUE)
--   → jeder eingeloggte Nutzer konnte sich in jede Firma eintragen.
DROP POLICY IF EXISTS "company_users_select" ON public.company_users;
CREATE POLICY "company_users_select" ON public.company_users FOR SELECT
  USING (user_id = auth.uid() OR company_id = public.get_my_company_id());

DROP POLICY IF EXISTS "company_users_insert" ON public.company_users;
CREATE POLICY "company_users_insert" ON public.company_users FOR INSERT
  WITH CHECK (
    company_id = public.get_my_company_id()
    AND public.my_company_role() IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS "company_users_delete" ON public.company_users;
CREATE POLICY "company_users_delete" ON public.company_users FOR DELETE
  USING (
    company_id = public.get_my_company_id()
    AND public.my_company_role() IN ('owner', 'admin')
  );
-- Kein UPDATE: Rollenänderungen nur über Server-Routen (gibt es noch nicht).

-- =============================================================================
-- 4. Firmendaten: lesen für alle Mitglieder, schreiben nur für Schreibrollen
-- =============================================================================
-- Vorher: "<tabelle>_all" FOR ALL für jedes Mitglied → viewer konnte über
-- den öffentlichen Anon-Key direkt aus dem Browser Kunden, Analysen usw.
-- anlegen, ändern und löschen. Die Oberfläche selbst schreibt nirgends
-- direkt in diese Tabellen, alle Schreibvorgänge laufen über Server-Routen.

DO $$
DECLARE
  t TEXT;
  old_policy TEXT;
BEGIN
  FOR t, old_policy IN
    SELECT * FROM (VALUES
      ('stores',            'stores_all'),
      ('uploads',           'uploads_all'),
      ('customers',         'customers_all'),
      ('analytics',         'analytics_all'),
      ('street_analytics',  'street_analytics_all'),
      ('marketing_actions', 'marketing_all'),
      ('alerts',            'alerts_all')
    ) AS v(t, p)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', old_policy, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (company_id = public.get_my_company_id())',
      t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (company_id = public.get_my_company_id() AND public.can_write_company_data())',
      t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (company_id = public.get_my_company_id() AND public.can_write_company_data()) WITH CHECK (company_id = public.get_my_company_id() AND public.can_write_company_data())',
      t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (company_id = public.get_my_company_id() AND public.can_write_company_data())',
      t || '_delete', t);
  END LOOP;
END $$;

-- =============================================================================
-- 5. Gemeinsame Referenzdaten: lesen ja, schreiben nur über den Server
-- =============================================================================
-- Vorher: RLS AUS auf postal_codes, streets, poi_businesses,
-- data_refresh_logs. In Supabase heißt das: Jeder mit dem öffentlichen
-- Anon-Key (steht im Browser-Code) kann diese Tabellen über die API
-- beschreiben und leeren, auch ohne Login.
ALTER TABLE public.postal_codes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.streets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poi_businesses    ENABLE ROW LEVEL SECURITY;
-- data_refresh_logs gibt es nur im Migrationsschema, nicht in SETUP_DATABASE.sql
DO $$
BEGIN
  IF to_regclass('public.data_refresh_logs') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.data_refresh_logs ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

DROP POLICY IF EXISTS "postal_codes_select"   ON public.postal_codes;
DROP POLICY IF EXISTS "streets_select"        ON public.streets;
DROP POLICY IF EXISTS "poi_businesses_select" ON public.poi_businesses;

-- Lesen für eingeloggte Nutzer (Wettbewerber- und B2B-Seite lesen direkt)
CREATE POLICY "postal_codes_select"   ON public.postal_codes   FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "streets_select"        ON public.streets        FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "poi_businesses_select" ON public.poi_businesses FOR SELECT TO authenticated USING (TRUE);
-- data_refresh_logs: keine Policy → nur der Server (Service-Key) liest und schreibt.
-- Keine INSERT/UPDATE/DELETE-Policies → Schreiben nur über den Service-Key.

-- =============================================================================
-- 6. Storage: nur eigener Firmenordner uploads/<company_id>/...
-- =============================================================================
-- Vorher: jeder eingeloggte Nutzer durfte alle Upload-Dateien lesen und
-- schreiben, obwohl der Kommentar „nur eigene Company-Uploads“ sagte.
DROP POLICY IF EXISTS "uploads_storage_insert" ON storage.objects;
DROP POLICY IF EXISTS "uploads_storage_select" ON storage.objects;

CREATE POLICY "uploads_storage_insert" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = public.get_my_company_id()::text
    AND public.can_write_company_data()
  );

CREATE POLICY "uploads_storage_select" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'uploads'
    AND (storage.foldername(name))[1] = public.get_my_company_id()::text
  );
-- Kein UPDATE/DELETE aus dem Browser.

UPDATE storage.buckets SET public = FALSE WHERE id = 'uploads';

-- =============================================================================
-- 7. OPTIONAL – erst nach Entscheidung aktivieren
-- =============================================================================
-- Ein Nutzer = eine Firma. Der Code geht heute überall davon aus.
-- Vorher prüfen: Abfrage 4 in check_live_policies.sql muss leer sein.
-- CREATE UNIQUE INDEX IF NOT EXISTS company_users_one_company_per_user
--   ON public.company_users (user_id);

COMMIT;
