-- =============================================================================
-- Rückfall zu Migration 010. NUR MIT FREIGABE ausführen.
-- Stellt die vor 010 gesicherten Rechte auf public.companies für anon und
-- authenticated wieder her (Tabellen- und Spaltenebene, inkl. GRANT OPTION).
-- Danach ist die Lücke wieder offen (Owner können Tarif u. a. ändern).
-- Die Sicherung wird danach geleert, damit ein erneutes 010 frisch sichert.
-- Bricht ab, wenn keine Sicherung vorhanden ist.
-- =============================================================================
BEGIN;
DO $rb$
DECLARE r record;
BEGIN
  IF to_regclass('migration_backup.m010_companies_acl') IS NULL
     OR NOT EXISTS (SELECT 1 FROM migration_backup.m010_companies_acl) THEN
    RAISE EXCEPTION 'Rückfall 010: keine Sicherung vorhanden';
  END IF;
  REVOKE ALL ON public.companies FROM anon;
  REVOKE ALL ON public.companies FROM authenticated;
  FOR r IN SELECT * FROM migration_backup.m010_companies_acl
           WHERE grantee IN ('anon','authenticated') ORDER BY ebene, spalte, grantee, privilege LOOP
    IF r.ebene = 'tabelle' THEN
      EXECUTE format('GRANT %s ON public.companies TO %I%s', r.privilege, r.grantee,
                     CASE WHEN r.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    ELSE
      EXECUTE format('GRANT %s (%I) ON public.companies TO %I%s', r.privilege, r.spalte, r.grantee,
                     CASE WHEN r.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$rb$;
DELETE FROM migration_backup.m010_companies_acl;
NOTIFY pgrst, 'reload schema';
COMMIT;
