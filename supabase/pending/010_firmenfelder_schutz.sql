-- =============================================================================
-- Migration 010: Geschützte Firmenfelder (Tarif, Laufzeit, Einstellungen, Schlüssel)
-- NUR MIT FREIGABE ausführen. Zuerst im Testprojekt, nie ohne Sicherung.
--
-- Problem: Die Regel companies_update erlaubt owner/admin zwar nur die eigene
-- Firma, schränkt aber die Spalten nicht ein. Ein Owner konnte so z. B. seinen
-- Tarif (plan) selbst ändern. Außerdem hatten anon und authenticated
-- Tabellenrechte, die weit über das hinausgehen, was die App braucht.
--
-- Lösung (Variante A): Spaltenrechte.
--   authenticated: lesen wie bisher; ändern NUR name, address, city, postal_code,
--                  country, phone, email, website, logo_url.
--                  Kein INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER.
--   anon:          kein Zugriff auf companies.
--   service_role, postgres und die Registrierung (register_company, SECURITY
--   DEFINER) bleiben unverändert.
--   Zeilenregeln (RLS) bleiben unverändert: Spaltenrechte und RLS gelten
--   zusammen, beide müssen erlauben.
-- NICHT Teil dieser Migration: Lesbarkeit von google_places_api_key
-- (eigener Sicherheitsfix, siehe Dokumentation).
--
-- Ablauf: 1. Rechte sichern  2. ändern  3. prüfen. Zweiter Lauf ändert nichts und
-- überschreibt die Sicherung nicht. Rückfall: 010_rollback.sql
-- =============================================================================
BEGIN;

-- 1. Sicherung der ursprünglichen Rechte (nur beim ersten Lauf) ---------------
CREATE SCHEMA IF NOT EXISTS migration_backup;
REVOKE ALL ON SCHEMA migration_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS migration_backup.m010_companies_acl (
  ebene      text    NOT NULL,   -- 'tabelle' oder 'spalte'
  spalte     text    NOT NULL,   -- '' bei Tabellenebene
  grantee    text    NOT NULL,   -- Rollenname, 'PUBLIC' für alle
  privilege  text    NOT NULL,
  grantable  boolean NOT NULL,
  saved_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON migration_backup.m010_companies_acl FROM PUBLIC, anon, authenticated;

INSERT INTO migration_backup.m010_companies_acl (ebene, spalte, grantee, privilege, grantable)
SELECT 'tabelle', '', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type, a.is_grantable
FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.oid = 'public.companies'::regclass
  AND NOT EXISTS (SELECT 1 FROM migration_backup.m010_companies_acl)
UNION ALL
SELECT 'spalte', at.attname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type, a.is_grantable
FROM pg_attribute at, LATERAL aclexplode(at.attacl) a
WHERE at.attrelid = 'public.companies'::regclass AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM migration_backup.m010_companies_acl);

-- 2. Rechte ändern -------------------------------------------------------------
-- REVOKE auf Tabellenebene entfernt auch eventuelle Spaltenrechte dieser Rollen.
REVOKE ALL ON public.companies FROM anon;
REVOKE ALL ON public.companies FROM authenticated;
GRANT SELECT ON public.companies TO authenticated;
GRANT UPDATE (name, address, city, postal_code, country, phone, email, website, logo_url)
  ON public.companies TO authenticated;

-- 3. Selbstprüfung: bei Abweichung bricht die Migration ab und nichts ändert sich
DO $check$
DECLARE
  protected text[] := ARRAY['id','slug','plan','plan_expires_at','settings','google_places_api_key','created_at','updated_at'];
  allowed   text[] := ARRAY['name','address','city','postal_code','country','phone','email','website','logo_url'];
  col text;
BEGIN
  FOREACH col IN ARRAY protected LOOP
    IF has_column_privilege('authenticated', 'public.companies', col, 'UPDATE')
       OR has_column_privilege('authenticated', 'public.companies', col, 'INSERT')
       OR has_column_privilege('anon', 'public.companies', col, 'UPDATE') THEN
      RAISE EXCEPTION 'Migration 010: Spalte % ist noch änderbar', col;
    END IF;
  END LOOP;
  FOREACH col IN ARRAY allowed LOOP
    IF NOT has_column_privilege('authenticated', 'public.companies', col, 'UPDATE') THEN
      RAISE EXCEPTION 'Migration 010: Spalte % ist nicht änderbar', col;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.companies', 'SELECT')
     OR has_table_privilege('authenticated', 'public.companies', 'INSERT')
     OR has_table_privilege('authenticated', 'public.companies', 'DELETE')
     OR has_table_privilege('authenticated', 'public.companies', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.companies', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.companies', 'SELECT') THEN
    RAISE EXCEPTION 'Migration 010: Tabellenrechte stimmen nicht';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
COMMIT;
