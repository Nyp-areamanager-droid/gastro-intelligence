-- =============================================================================
-- NUR LESEN – zweite Vorprüfung vor Migration 002. Ändert nichts.
-- Ergebnis als CSV exportieren. Spalte "details" kann E-Mail-Adressen
-- eurer eigenen Nutzer enthalten (Teil E) – die musst du mir nicht schicken,
-- es reicht, wenn du sagst, ob alle Mitglieder bekannt sind.
-- =============================================================================

-- A. Rollen der bestehenden Nutzer (wer darf nach Phase 0 noch importieren?)
SELECT 'A Rollen' AS pruefung, role::text AS objekt,
       'Anzahl Nutzer: ' || count(*)::text AS name, '' AS details
FROM public.company_users
GROUP BY role

UNION ALL

-- B. Erlaubte Werte der Rollen-Liste (muss owner, admin, manager, viewer enthalten)
SELECT 'B Rollen-Typ', t.typname,
       string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder), ''
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'user_role'
GROUP BY t.typname

UNION ALL

-- C. Signaturen der Hilfsfunktionen (Migration ersetzt sie, Typen müssen passen)
SELECT 'C Funktion', p.proname,
       '(' || pg_get_function_identity_arguments(p.oid) || ') → ' || pg_get_function_result(p.oid),
       CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'normal' END
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('get_my_company_id', 'is_company_member', 'my_company_role',
                    'can_write_company_data', 'on_auth_user_created')

UNION ALL

-- D. Spalte joined_at in company_users vorhanden? (Migration sortiert danach)
SELECT 'D Spalte', 'company_users.' || column_name, data_type, ''
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'company_users'
  AND column_name IN ('joined_at', 'role', 'company_id', 'user_id')

UNION ALL

-- E. Mitglieder je Firma (unerwartete Mitglieder = mögliche Nutzung der Lücke)
SELECT 'E Mitglieder', c.name,
       cu.role::text || ' seit ' || to_char(cu.joined_at, 'YYYY-MM-DD HH24:MI'),
       coalesce(u.email, '(ohne E-Mail)')
FROM public.company_users cu
JOIN public.companies c ON c.id = cu.company_id
LEFT JOIN auth.users u ON u.id = cu.user_id

UNION ALL

-- F. Buckets (Name muss 'uploads' sein)
SELECT 'F Bucket', id, CASE WHEN public THEN 'ÖFFENTLICH' ELSE 'privat' END, ''
FROM storage.buckets

UNION ALL

-- G. Tabellen, die Migration 002 erwartet (fehlt eine, bricht 002 sauber ab)
SELECT 'G Tabelle', t.name,
       CASE WHEN to_regclass('public.' || t.name) IS NULL THEN 'FEHLT' ELSE 'vorhanden' END, ''
FROM (VALUES ('companies'),('company_users'),('stores'),('uploads'),('customers'),
             ('analytics'),('street_analytics'),('marketing_actions'),('alerts'),
             ('postal_codes'),('streets'),('poi_businesses'),('data_refresh_logs')) AS t(name)

ORDER BY 1, 2, 3;
