-- =============================================================================
-- Rückfall zu Migration 012. NUR MIT FREIGABE ausführen.
-- Stellt die vor 012 gesicherten Rechte von anon und authenticated auf allen
-- Tabellen in public (außer companies) wieder her, inkl. Spaltenrechte, GRANT OPTION
-- und der Standardrechte für neue Tabellen. Bricht ab, wenn keine Sicherung existiert.
-- =============================================================================
BEGIN;
DO $rb$
DECLARE t record; r record;
BEGIN
  IF to_regclass('migration_backup.m012_acl') IS NULL OR NOT EXISTS (SELECT 1 FROM migration_backup.m012_acl) THEN
    RAISE EXCEPTION 'Rückfall 012: keine Sicherung vorhanden';
  END IF;
  FOR t IN SELECT relname FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> 'companies' AND relowner = current_user::regrole LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.relname);
  END LOOP;
  FOR r IN SELECT * FROM migration_backup.m012_acl WHERE ebene IN ('tabelle', 'spalte')
           AND to_regclass(format('public.%I', tabelle)) IS NOT NULL ORDER BY tabelle, ebene, spalte, grantee, privilege LOOP
    IF r.ebene = 'tabelle' THEN
      EXECUTE format('GRANT %s ON public.%I TO %I%s', r.privilege, r.tabelle, r.grantee, CASE WHEN r.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    ELSE
      EXECUTE format('GRANT %s (%I) ON public.%I TO %I%s', r.privilege, r.spalte, r.tabelle, r.grantee, CASE WHEN r.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
  FOR r IN SELECT DISTINCT grantee FROM migration_backup.m012_acl WHERE ebene = 'standard' LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO %I', r.grantee);
  END LOOP;
END
$rb$;
DELETE FROM migration_backup.m012_acl;
NOTIFY pgrst, 'reload schema';
COMMIT;
