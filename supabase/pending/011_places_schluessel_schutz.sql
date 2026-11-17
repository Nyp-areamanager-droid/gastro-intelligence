-- =============================================================================
-- Migration 011: Google-Places-Schlüssel nicht mehr für normale Mitglieder lesbar
-- NUR MIT FREIGABE ausführen. Zuerst im Testprojekt. Voraussetzung: Migration 010.
--
-- Problem: companies.google_places_api_key war für jedes Firmenmitglied (auch
-- viewer) über die Datenbank-Schnittstelle lesbar.
--
-- Lösung:
--   * authenticated darf companies weiter lesen, aber NICHT die Spalte
--     google_places_api_key (Spaltenrecht SELECT auf alle übrigen Spalten).
--   * Neue Funktion get_company_places_key(): liefert den Schlüssel der EIGENEN
--     Firma nur an owner und admin, sonst NULL. Der Import (/api/upload) liest ihn
--     darüber. Manager und Viewer erhalten NULL: Der Import läuft dann ohne
--     Google-Places-Anreicherung.
--   * Setzen des Schlüssels: nur durch den Betreiber (service_role/SQL), wie seit 010.
--   * Neue Spalten in companies sind für die App erst nach einem eigenen GRANT lesbar
--     (bewusst: sicher als Standard).
-- Ablauf: sichern, ändern, prüfen (bricht bei Abweichung ab). Zweiter Lauf ändert
-- nichts und überschreibt die Sicherung nicht. Rückfall: 011_rollback.sql
-- =============================================================================
BEGIN;

DO $pre$
BEGIN
  IF has_table_privilege('authenticated', 'public.companies', 'INSERT')
     OR has_column_privilege('authenticated', 'public.companies', 'plan', 'UPDATE') THEN
    RAISE EXCEPTION 'Migration 011: Migration 010 ist nicht eingespielt';
  END IF;
END
$pre$;

-- 1. Sicherung der Rechte von authenticated (nur beim ersten Lauf) --------------
CREATE SCHEMA IF NOT EXISTS migration_backup;
REVOKE ALL ON SCHEMA migration_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS migration_backup.m011_companies_acl (
  ebene text NOT NULL, spalte text NOT NULL, grantee text NOT NULL,
  privilege text NOT NULL, grantable boolean NOT NULL, saved_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON migration_backup.m011_companies_acl FROM PUBLIC, anon, authenticated;

INSERT INTO migration_backup.m011_companies_acl (ebene, spalte, grantee, privilege, grantable)
SELECT 'tabelle', '', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type, a.is_grantable
FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.oid = 'public.companies'::regclass AND NOT EXISTS (SELECT 1 FROM migration_backup.m011_companies_acl)
UNION ALL
SELECT 'spalte', at.attname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type, a.is_grantable
FROM pg_attribute at, LATERAL aclexplode(at.attacl) a
WHERE at.attrelid = 'public.companies'::regclass AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM migration_backup.m011_companies_acl);

-- 2. Funktion für den Schlüssel ------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_company_places_key()
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT c.google_places_api_key
  FROM public.companies c
  WHERE c.id = public.get_my_company_id()
    AND public.my_company_role() IN ('owner', 'admin');
$$;
REVOKE ALL ON FUNCTION public.get_company_places_key() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_company_places_key() TO authenticated, service_role;

-- 3. Leserechte: alle Spalten außer dem Schlüssel -------------------------------
REVOKE SELECT ON public.companies FROM authenticated;
DO $g$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols
  FROM pg_attribute
  WHERE attrelid = 'public.companies'::regclass AND attnum > 0 AND NOT attisdropped
    AND attname <> 'google_places_api_key';
  EXECUTE format('GRANT SELECT (%s) ON public.companies TO authenticated', cols);
END
$g$;

-- 4. Selbstprüfung ---------------------------------------------------------------
DO $check$
BEGIN
  IF has_column_privilege('authenticated', 'public.companies', 'google_places_api_key', 'SELECT')
     OR has_column_privilege('anon', 'public.companies', 'google_places_api_key', 'SELECT')
     OR has_table_privilege('authenticated', 'public.companies', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.companies', 'name', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.companies', 'plan', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.companies', 'google_places_api_key', 'SELECT')
     OR has_function_privilege('anon', 'public.get_company_places_key()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_company_places_key()', 'EXECUTE')
     OR has_column_privilege('authenticated', 'public.companies', 'plan', 'UPDATE') THEN
    RAISE EXCEPTION 'Migration 011: Rechte stimmen nicht';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
COMMIT;
