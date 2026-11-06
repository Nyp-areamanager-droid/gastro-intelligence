-- =============================================================================
-- NUR LESEN – ändert nichts an Daten oder Regeln.
--
-- Ausführen:
--   1. supabase.com öffnen, Projekt auswählen
--   2. Links "SQL Editor" → "New query"
--   3. Diesen gesamten Text einfügen → "Run"
--   4. Supabase zeigt nur das Ergebnis der LETZTEN Abfrage an.
--      Deshalb ist alles zu EINER Ergebnistabelle zusammengefasst.
--      Ergebnis als CSV herunterladen ("Export" / "Download CSV")
--      oder Screenshots machen und zurückschicken.
--
-- Enthält keine Kundendaten: nur Regeln, Tabelleneinstellungen und Zahlen.
-- =============================================================================

-- 1. Alle RLS-Regeln für App-Tabellen und Storage
SELECT
  '1 Policy'                                   AS pruefung,
  schemaname || '.' || tablename               AS objekt,
  policyname || ' [' || cmd || ']'             AS name,
  coalesce('USING ' || qual, '') ||
  coalesce('  CHECK ' || with_check, '')       AS details
FROM pg_policies
WHERE schemaname IN ('public', 'storage')

UNION ALL

-- 2. RLS an/aus je Tabelle
SELECT
  '2 RLS-Status',
  'public.' || relname,
  CASE WHEN relrowsecurity THEN 'RLS AN' ELSE 'RLS AUS' END,
  ''
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'

UNION ALL

-- 3. Ist der Upload-Bucket privat?
SELECT
  '3 Bucket',
  'storage.buckets.' || id,
  CASE WHEN public THEN 'ÖFFENTLICH' ELSE 'privat' END,
  ''
FROM storage.buckets

UNION ALL

-- 4. Hilfsfunktionen: Inhalt und fester Suchpfad
SELECT
  '4 Funktion',
  'public.' || p.proname,
  CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'normal' END ||
  CASE WHEN p.proconfig IS NULL THEN ' / ohne search_path' ELSE ' / ' || array_to_string(p.proconfig, ',') END,
  regexp_replace(p.prosrc, '\s+', ' ', 'g')
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('get_my_company_id', 'is_company_member', 'my_company_role',
                    'can_write_company_data', 'on_auth_user_created', 'update_updated_at')

UNION ALL

-- 5. Nutzer in mehr als einer Firma (nur Anzahl, keine IDs)
SELECT
  '5 Mehrfach-Firmen',
  'company_users',
  'Nutzer mit mehreren Firmen: ' || count(*)::text,
  ''
FROM (
  SELECT user_id FROM public.company_users GROUP BY user_id HAVING count(*) > 1
) m

UNION ALL

-- 6. Nutzer ohne Firma und Firmen ohne Owner (nur Anzahl)
SELECT
  '6 Zuordnung',
  'auth.users / companies',
  'Konten ohne Firma: ' ||
    (SELECT count(*) FROM auth.users u
      WHERE NOT EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.user_id = u.id))::text ||
  ' / Firmen ohne Owner: ' ||
    (SELECT count(*) FROM public.companies c
      WHERE NOT EXISTS (SELECT 1 FROM public.company_users cu
                        WHERE cu.company_id = c.id AND cu.role = 'owner'))::text,
  ''

ORDER BY 1, 2, 3;
