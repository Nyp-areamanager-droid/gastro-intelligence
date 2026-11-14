-- =============================================================================
-- Migration 009: Deutschlandweite Geodaten (Straßenverzeichnis, PLZ-Qualität,
-- Zuordnungsstatus der Adressen)
-- ENTWURF – in der Produktion NUR mit ausdrücklicher Freigabe von Redouan.
-- Voraussetzung: Migration 002 (Rollen, Hilfsfunktionen), 005 (Herkunft Einwohner).
--
-- 1. Neue Tabellen public.street_directory (alle Straßennamen je PLZ) und
--    public.plz_localities (Orte/Stadtteile je PLZ), aus dem OpenPLZ-Datensatz
--    (OpenStreetMap, ODbL).
--    Gemeinsame Referenzdaten ohne Firmenbezug:
--      - Lesen: angemeldete Nutzer (für die Adresszuordnung beim Import)
--      - Schreiben: niemand über die App. Befüllt wird sie ausschließlich mit
--        scripts/geodaten/laden.ts über eine direkte Datenbankverbindung.
--      - Ohne Anmeldung (anon): kein Zugriff.
--    Der Service-Key-Client der App (createReferenceDataClient) bekommt
--    diese Tabellen bewusst NICHT.
-- 2. postal_codes: Gemeindeschlüssel, Zuverlässigkeit der Einwohner- und
--    Haushaltszahl, Version der Referenzdaten.
-- 3. customers.geo_status: Ergebnis der Adresszuordnung je Datensatz.
--    uploads.geo_summary: Zusammenfassung je Import (Erfolgsquote).
--
-- Ändert keine vorhandenen Daten und keine bestehenden Zugriffsregeln.
-- Zweiter Lauf: ändert nichts. Rückfall: 009_rollback.sql
-- Speicherbedarf nach dem Laden: siehe docs/geodaten-deutschland.md
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.postal_codes') IS NULL OR to_regclass('public.customers') IS NULL OR to_regclass('public.uploads') IS NULL THEN
    RAISE EXCEPTION 'Abbruch: Grundtabellen fehlen. Es wurde nichts geändert.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'postal_codes' AND column_name = 'population_method') THEN
    RAISE EXCEPTION 'Abbruch: Migration 005 fehlt (postal_codes.population_method). Es wurde nichts geändert.';
  END IF;
END $$;

-- Eine Zeile je PLZ mit allen Straßennamen als Liste. PostgreSQL speichert
-- lange Listen komprimiert; das hält die Tabelle klein (gemessen: siehe Doku).
CREATE TABLE IF NOT EXISTS public.street_directory (
  postal_code   TEXT PRIMARY KEY CHECK (postal_code ~ '^[0-9]{5}$'),
  streets       TEXT[] NOT NULL,
  street_count  INTEGER NOT NULL,
  version       TEXT NOT NULL
);
-- Orte, Stadtbezirke und Stadtteile je PLZ (für Importe ohne PLZ)
CREATE TABLE IF NOT EXISTS public.plz_localities (
  postal_code   TEXT NOT NULL CHECK (postal_code ~ '^[0-9]{5}$'),
  locality      TEXT NOT NULL,
  locality_key  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ort', 'bezirk', 'stadtteil')),
  PRIMARY KEY (locality_key, postal_code, kind)
);
CREATE INDEX IF NOT EXISTS plz_localities_postal_idx ON public.plz_localities (postal_code);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['street_directory', 'plz_localities'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON public.%I FROM anon', t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (TRUE)', t || '_select', t);
  END LOOP;
END $$;

ALTER TABLE public.postal_codes ADD COLUMN IF NOT EXISTS ags TEXT;
ALTER TABLE public.postal_codes ADD COLUMN IF NOT EXISTS population_quality TEXT;
ALTER TABLE public.postal_codes ADD COLUMN IF NOT EXISTS households_quality TEXT;
ALTER TABLE public.postal_codes ADD COLUMN IF NOT EXISTS reference_version TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postal_codes_population_quality_check') THEN
    ALTER TABLE public.postal_codes ADD CONSTRAINT postal_codes_population_quality_check
      CHECK (population_quality IS NULL OR population_quality IN ('gut', 'eingeschraenkt', 'keine_bewohner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'postal_codes_households_quality_check') THEN
    ALTER TABLE public.postal_codes ADD CONSTRAINT postal_codes_households_quality_check
      CHECK (households_quality IS NULL OR households_quality IN ('gut', 'eingeschraenkt', 'keine_bewohner'));
  END IF;
END $$;

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS geo_status TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_geo_status_check') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_geo_status_check
      CHECK (geo_status IS NULL OR geo_status IN ('exakt', 'schreibweise', 'plz_ergaenzt', 'mehrdeutig', 'plz_pruefen',
                                                   'strasse_unbekannt', 'plz_unbekannt', 'ohne_strasse', 'ohne_ort'));
  END IF;
END $$;
ALTER TABLE public.uploads ADD COLUMN IF NOT EXISTS geo_summary JSONB;

-- Prüfen
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['street_directory', 'plz_localities'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'Abbruch: RLS auf % nicht aktiv.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND has_table_privilege('anon', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'Abbruch: anon darf % lesen.', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       AND (has_table_privilege('authenticated', 'public.' || t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
            OR has_table_privilege('authenticated', 'public.' || t, 'DELETE') OR has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE')) THEN
      RAISE EXCEPTION 'Abbruch: angemeldete Nutzer dürfen % ändern.', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
