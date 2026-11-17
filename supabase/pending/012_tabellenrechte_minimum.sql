-- =============================================================================
-- Migration 012: Tabellenrechte für anon und authenticated auf das Nötige kürzen
-- NUR MIT FREIGABE ausführen. Zuerst im Testprojekt. Voraussetzung: 010, 011.
--
-- Problem: Supabase vergibt an anon und authenticated standardmäßig ALLE Rechte
-- auf alle Tabellen (inkl. TRUNCATE, REFERENCES, TRIGGER, MAINTAIN). Die
-- Zeilenregeln (RLS) schützen zwar Zeilen, aber TRUNCATE kennt keine Zeilenregeln,
-- und anon braucht auf App-Tabellen gar keinen Zugriff.
--
-- Neu (Tabelle companies bleibt wie in 010/011):
--   anon           : kein Zugriff auf irgendeine Tabelle in public.
--   authenticated  : alerts, analytics, customers, marketing_actions,
--                    street_analytics, uploads  -> SELECT, INSERT, UPDATE, DELETE
--                    (der Server schreibt mit der Nutzersitzung, RLS entscheidet je Zeile)
--                    stores, company_users -> SELECT (die App schreibt dort nicht;
--                    Filialen und Mitglieder legt der Betreiber an)
--                    postal_codes, streets, poi_businesses, plz_localities,
--                    street_directory -> SELECT (Schreiben nur über den Service-Key)
--                    data_refresh_logs -> kein Zugriff (nur Service-Key)
--                    nie: TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
--   service_role, postgres: unverändert.
--   Neue Tabellen in public bekommen für anon/authenticated keine Rechte mehr
--   automatisch (Standardrechte des Rolle postgres); sie brauchen ein eigenes GRANT.
-- Ablauf: sichern, ändern, prüfen (bricht bei Abweichung ab). Zweiter Lauf ändert
-- nichts und überschreibt die Sicherung nicht. Rückfall: 012_rollback.sql
-- =============================================================================
BEGIN;

DO $pre$
BEGIN
  IF has_table_privilege('authenticated', 'public.companies', 'INSERT')
     OR has_column_privilege('authenticated', 'public.companies', 'google_places_api_key', 'SELECT') THEN
    RAISE EXCEPTION 'Migration 012: Migrationen 010 und 011 sind nicht eingespielt';
  END IF;
END
$pre$;

-- 1. Sicherung der Rechte (Tabellen- und Spaltenebene) und der Standardrechte ---
CREATE SCHEMA IF NOT EXISTS migration_backup;
REVOKE ALL ON SCHEMA migration_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS migration_backup.m012_acl (
  tabelle text NOT NULL, ebene text NOT NULL, spalte text NOT NULL, grantee text NOT NULL,
  privilege text NOT NULL, grantable boolean NOT NULL, saved_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON migration_backup.m012_acl FROM PUBLIC, anon, authenticated;

INSERT INTO migration_backup.m012_acl (tabelle, ebene, spalte, grantee, privilege, grantable)
SELECT c.relname, 'tabelle', '', a.grantee::regrole::text, a.privilege_type, a.is_grantable
FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> 'companies'
  AND c.relowner = current_user::regrole
  AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  AND NOT EXISTS (SELECT 1 FROM migration_backup.m012_acl)
UNION ALL
SELECT c.relname, 'spalte', at.attname, a.grantee::regrole::text, a.privilege_type, a.is_grantable
FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL,
     LATERAL aclexplode(at.attacl) a
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> 'companies'
  AND c.relowner = current_user::regrole
  AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  AND NOT EXISTS (SELECT 1 FROM migration_backup.m012_acl)
UNION ALL
SELECT '*standard*', 'standard', '', r.rolname, 'ALL', false
FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a, pg_roles r
WHERE d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'
  AND d.defaclrole = 'postgres'::regrole AND r.oid = a.grantee AND r.rolname IN ('anon', 'authenticated')
  AND a.privilege_type = 'INSERT'
  AND NOT EXISTS (SELECT 1 FROM migration_backup.m012_acl);

-- 2. Alles entziehen (außer companies), dann gezielt vergeben --------------------
-- Nur Tabellen, die der ausführenden Rolle gehören: Erweiterungstabellen wie public.spatial_ref_sys (PostGIS, Besitzer supabase_admin)
-- sind nicht Teil der App; ein REVOKE darauf würde in Produktion scheitern oder die Selbstprüfung auslösen.
DO $rights$
DECLARE t record;
BEGIN
  FOR t IN SELECT relname FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> 'companies' AND relowner = current_user::regrole LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.relname);
  END LOOP;
END
$rights$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts, public.analytics, public.customers,
  public.marketing_actions, public.street_analytics, public.uploads TO authenticated;
GRANT SELECT ON public.stores, public.company_users, public.postal_codes, public.streets,
  public.poi_businesses, public.plz_localities, public.street_directory TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

-- 3. Selbstprüfung -----------------------------------------------------------------
DO $check$
DECLARE t record; p text;
  verboten text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
BEGIN
  FOR t IN SELECT relname FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> 'companies' AND relowner = current_user::regrole LOOP
    IF EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               WHERE c.oid = format('public.%I', t.relname)::regclass AND a.grantee = 'anon'::regrole)
       OR EXISTS (SELECT 1 FROM pg_attribute at, LATERAL aclexplode(at.attacl) a
                  WHERE at.attrelid = format('public.%I', t.relname)::regclass AND at.attacl IS NOT NULL AND a.grantee = 'anon'::regrole) THEN
      RAISE EXCEPTION 'Migration 012: anon hat noch Rechte auf %', t.relname;
    END IF;
    FOREACH p IN ARRAY verboten LOOP
      IF has_table_privilege('authenticated', format('public.%I', t.relname), p) THEN
        RAISE EXCEPTION 'Migration 012: authenticated hat noch % auf %', p, t.relname;
      END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.data_refresh_logs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.streets', 'INSERT')
     OR has_table_privilege('authenticated', 'public.stores', 'INSERT')
     OR has_table_privilege('authenticated', 'public.company_users', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.customers', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.uploads', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.company_users', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.postal_codes', 'SELECT') THEN
    RAISE EXCEPTION 'Migration 012: Rechte stimmen nicht';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
COMMIT;
