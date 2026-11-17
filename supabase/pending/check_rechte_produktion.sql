-- NUR LESEN – ändert nichts. Im Supabase SQL-Editor des PRODUKTIONSprojekts ausführen (eine Ergebnistabelle).
-- Zweck: Die Sicherung wurde mit --no-acl erstellt; diese Abfrage liefert, was darin fehlt (Tabellenrechte, Auslöser auf auth.users).
-- Enthält keine Kundendaten und keine Passwörter.
SELECT 'A Tabellenrechte public' AS pruefung, c.relname AS objekt,
       coalesce((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type, ', ' ORDER BY a.grantee::regrole::text, a.privilege_type)
                 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 WHERE a.grantee = 0 OR a.grantee::regrole::text IN ('anon','authenticated','service_role')), '') AS details
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
UNION ALL
SELECT 'B Auslöser auf auth.users', t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal
UNION ALL
SELECT 'C Funktionsrechte public', p.oid::regprocedure::text,
       coalesce((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ', ' ORDER BY a.grantee::regrole::text)
                 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE'), '')
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
UNION ALL
SELECT 'D Storage-Regeln', policyname, tablename || ' ' || cmd || ' ' || roles::text FROM pg_policies WHERE schemaname = 'storage'
ORDER BY 1, 2;
