-- =============================================================================
-- RÜCKFALL für Migration 002 – NUR AUSFÜHREN, WENN NACH 002 ETWAS NICHT GEHT
--
-- Stellt exakt den Zustand vor Migration 002 wieder her:
--   - alle Regeln (Policies) der 13 App-Tabellen und die Storage-Regeln
--     für den Bucket 'uploads'
--   - die Hilfsfunktionen in ihrer ursprünglichen Fassung
--   - RLS an/aus je Tabelle
--   - die Bucket-Einstellung
-- Quelle ist die Sicherung, die 002 vor jeder Änderung in
-- migration_backup.m002_state geschrieben hat. Ohne diese Sicherung bricht
-- das Skript ab und ändert nichts.
--
-- Daten (Kunden, Analysen, Uploads, Nutzer) werden nicht angefasst.
--
-- ACHTUNG: Danach sind die Sicherheitslücken wieder offen, auch
-- company_users_insert_own. Der Rückfall ist nur eine Notlösung, bis der
-- Fehler gefunden ist.
--
-- Alles in EINER Transaktion: Schlägt ein Schritt fehl, bleibt der Zustand
-- nach 002 unverändert erhalten.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  r RECORD;
  app_tables TEXT[] := ARRAY['companies','company_users','stores','uploads','customers',
                             'analytics','street_analytics','marketing_actions','alerts',
                             'postal_codes','streets','poi_businesses','data_refresh_logs'];
BEGIN
  -- 1. Sicherung vorhanden und vollständig?
  IF to_regclass('migration_backup.m002_state') IS NULL
     OR NOT EXISTS (SELECT 1 FROM migration_backup.m002_state
                    WHERE kind = 'marker' AND object = 'complete') THEN
    RAISE EXCEPTION 'Keine vollständige Sicherung von Migration 002 gefunden – Rückfall abgebrochen, nichts geändert';
  END IF;

  -- 2. Alle heutigen Regeln dieser Tabellen entfernen
  FOR r IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE (schemaname = 'public' AND tablename = ANY (app_tables))
       OR (schemaname = 'storage' AND tablename = 'objects'
           AND (coalesce(qual,'') LIKE '%uploads%' OR coalesce(with_check,'') LIKE '%uploads%'))
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;

  -- 3. Ursprüngliche Hilfsfunktionen wiederherstellen.
  --    Nicht löschen (eine Funktion kann an einem Trigger hängen), sondern
  --    erst die von 002 ergänzten Einstellungen (search_path) zurücksetzen
  --    und dann die gesicherte Fassung per CREATE OR REPLACE einspielen.
  FOR r IN SELECT object, statement FROM migration_backup.m002_state
           WHERE kind = 'function' ORDER BY id
  LOOP
    PERFORM 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.object;
    IF FOUND THEN
      EXECUTE (SELECT format('ALTER FUNCTION %s RESET ALL', p.oid::regprocedure)
               FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.object
               LIMIT 1);
    END IF;
    EXECUTE r.statement;
  END LOOP;

  -- 4. Funktionen, die erst 002 angelegt hat, wieder entfernen
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('get_my_company_id', 'is_company_member', 'my_company_role',
                        'can_write_company_data', 'on_auth_user_created')
      AND NOT EXISTS (SELECT 1 FROM migration_backup.m002_state s
                      WHERE s.kind = 'function' AND s.object = p.proname)
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.sig);
  END LOOP;

  -- 5. Ursprüngliche Regeln anlegen
  FOR r IN SELECT statement FROM migration_backup.m002_state
           WHERE kind = 'policy' ORDER BY id
  LOOP
    EXECUTE r.statement;
  END LOOP;

  -- 6. RLS an/aus wie vorher
  FOR r IN SELECT statement FROM migration_backup.m002_state
           WHERE kind = 'rls' ORDER BY id
  LOOP
    EXECUTE r.statement;
  END LOOP;

  -- 7. Bucket-Einstellung wie vorher
  FOR r IN SELECT statement FROM migration_backup.m002_state
           WHERE kind = 'bucket' ORDER BY id
  LOOP
    EXECUTE r.statement;
  END LOOP;

  RAISE NOTICE 'Rückfall abgeschlossen: Zustand vor Migration 002 wiederhergestellt';
END $$;

COMMIT;
