-- =============================================================================
-- Rückfall zu Migration 006. NUR MIT FREIGABE ausführen.
-- Stellt exakt den gesicherten Zustand vor 006 wieder her: Rechte der
-- Hilfsfunktionen und von on_auth_user_created(), Einstellungen von update_updated_at(), Grenzen des
-- Speicherbereichs uploads. Bricht ab (ohne Änderung), wenn keine
-- vollständige Sicherung da ist oder der Zustand seit 006 verändert wurde.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  r RECORD;
  g RECORD;
  ok_state BOOLEAN;
BEGIN
  IF to_regclass('migration_backup.m006_state') IS NULL THEN
    RAISE EXCEPTION 'Abbruch: Keine Sicherung vorhanden. Es wurde nichts geändert.';
  END IF;
  IF (SELECT count(*) FROM migration_backup.m006_state WHERE kind = 'acl') < 3
     OR (SELECT count(*) FROM migration_backup.m006_state WHERE kind = 'config') <> 1
     OR (SELECT count(*) FROM migration_backup.m006_state WHERE kind = 'bucket') <> 1 THEN
    RAISE EXCEPTION 'Abbruch: Sicherung unvollständig. Es wurde nichts geändert.';
  END IF;

  -- Zustand = Zustand direkt nach 006?
  ok_state :=
        NOT EXISTS (SELECT 1 FROM migration_backup.m006_state b WHERE b.kind = 'acl'
                    AND (to_regprocedure(b.object) IS NULL
                         OR has_function_privilege('anon', b.object, 'EXECUTE')
                         OR NOT has_function_privilege('authenticated', b.object, 'EXECUTE')))
    AND NOT EXISTS (SELECT 1 FROM migration_backup.m006_state b WHERE b.kind = 'acl_trigger'
                    AND (to_regprocedure(b.object) IS NULL
                         OR has_function_privilege('anon', b.object, 'EXECUTE')
                         OR has_function_privilege('authenticated', b.object, 'EXECUTE')))
    AND (SELECT proconfig FROM pg_proc WHERE oid = 'public.update_updated_at()'::regprocedure) = ARRAY['search_path=""']
    AND EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uploads' AND file_size_limit = 4194304);
  IF NOT ok_state THEN
    RAISE EXCEPTION 'Abbruch: Der Zustand wurde seit Migration 006 verändert. Der Rückfall würde das überschreiben. Es wurde nichts geändert.';
  END IF;

  -- Rechte: alles entziehen, dann exakt die gesicherten Einträge neu vergeben
  FOR r IN SELECT * FROM migration_backup.m006_state WHERE kind IN ('acl', 'acl_trigger') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.object);
    FOR g IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', r.object, g.rolname);
    END LOOP;
    FOR g IN
      SELECT a.grantee, a.privilege_type, a.is_grantable
      FROM pg_proc p,
           aclexplode(coalesce(r.acl::aclitem[], acldefault('f', p.proowner))) a
      WHERE p.oid = r.object::regprocedure AND a.grantee <> p.proowner
    LOOP
      EXECUTE format('GRANT %s ON FUNCTION %s TO %s%s', g.privilege_type, r.object,
        CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident((SELECT rolname FROM pg_roles WHERE oid = g.grantee)) END,
        CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;

  -- update_updated_at(): Suchpfad wie vorher
  SELECT * INTO r FROM migration_backup.m006_state WHERE kind = 'config';
  IF r.config IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(r.config) c WHERE c LIKE 'search_path=%') THEN
    EXECUTE 'ALTER FUNCTION public.update_updated_at() RESET search_path';
  ELSE
    EXECUTE format('ALTER FUNCTION public.update_updated_at() SET search_path = %s',
      (SELECT substr(c, length('search_path=') + 1) FROM unnest(r.config) c WHERE c LIKE 'search_path=%'));
  END IF;

  -- Speicherbereich wie vorher
  UPDATE storage.buckets k SET file_size_limit = b.file_size_limit, allowed_mime_types = b.allowed_mime_types
  FROM migration_backup.m006_state b WHERE b.kind = 'bucket' AND k.id = b.object;

  -- Ergebnis prüfen: Rechte inhaltlich gleich, Einstellungen gleich, Bucket gleich
  IF EXISTS (
       SELECT 1 FROM migration_backup.m006_state b JOIN pg_proc p ON p.oid = b.object::regprocedure
       WHERE b.kind IN ('acl', 'acl_trigger') AND (
         SELECT array_agg(x ORDER BY x) FROM (SELECT (a.grantee, a.privilege_type, a.is_grantable)::text x
           FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) s)
         IS DISTINCT FROM (
         SELECT array_agg(x ORDER BY x) FROM (SELECT (a.grantee, a.privilege_type, a.is_grantable)::text x
           FROM aclexplode(coalesce(b.acl::aclitem[], acldefault('f', p.proowner))) a) s))
     OR (SELECT config FROM migration_backup.m006_state WHERE kind = 'config')
          IS DISTINCT FROM (SELECT proconfig FROM pg_proc WHERE oid = 'public.update_updated_at()'::regprocedure)
     OR EXISTS (SELECT 1 FROM migration_backup.m006_state b JOIN storage.buckets k ON k.id = b.object
                WHERE b.kind = 'bucket' AND (b.file_size_limit IS DISTINCT FROM k.file_size_limit
                                             OR b.allowed_mime_types IS DISTINCT FROM k.allowed_mime_types::text[])) THEN
    RAISE EXCEPTION 'Abbruch: Wiederherstellung nicht vollständig. Es wurde nichts geändert.';
  END IF;

  DROP TABLE migration_backup.m006_state;
END $$;
COMMIT;
