-- =============================================================================
-- Rückfall zu Migration 011. NUR MIT FREIGABE ausführen.
-- Stellt die vor 011 gesicherten Rechte von authenticated auf public.companies
-- wieder her (Stand nach 010) und entfernt get_company_places_key().
-- Danach ist der Schlüssel wieder für alle Mitglieder lesbar.
-- Bricht ab, wenn keine Sicherung vorhanden ist.
-- =============================================================================
BEGIN;
DO $rb$
DECLARE r record;
BEGIN
  IF to_regclass('migration_backup.m011_companies_acl') IS NULL
     OR NOT EXISTS (SELECT 1 FROM migration_backup.m011_companies_acl) THEN
    RAISE EXCEPTION 'Rückfall 011: keine Sicherung vorhanden';
  END IF;
  REVOKE ALL ON public.companies FROM authenticated;
  FOR r IN SELECT * FROM migration_backup.m011_companies_acl
           WHERE grantee = 'authenticated' ORDER BY ebene, spalte, privilege LOOP
    IF r.ebene = 'tabelle' THEN
      EXECUTE format('GRANT %s ON public.companies TO authenticated%s', r.privilege, CASE WHEN r.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    ELSE
      EXECUTE format('GRANT %s (%I) ON public.companies TO authenticated%s', r.privilege, r.spalte, CASE WHEN r.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$rb$;
DROP FUNCTION IF EXISTS public.get_company_places_key();
DELETE FROM migration_backup.m011_companies_acl;
NOTIFY pgrst, 'reload schema';
COMMIT;
