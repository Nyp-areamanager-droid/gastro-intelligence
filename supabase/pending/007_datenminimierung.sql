-- =============================================================================
-- Migration 007: Datenminimierung im Kundenbestand
-- ENTWURF – in der Produktion NUR mit ausdrücklicher Freigabe von Redouan.
--
-- ACHTUNG: Diese Migration LÖSCHT Daten endgültig. Es gibt KEINEN Rückfall.
-- Vorher eine Datenbanksicherung anlegen (siehe Übernahmeplan).
--
-- Was sie tut (nur Tabelle public.customers, alle Firmen):
--   1. Telefonnummern im Klartext werden durch ein Kennzeichen ersetzt:
--        'p1:' + SHA-256( Firmen-ID + ':' + normalisierte Nummer )
--      Dieselbe Rechnung wie im Programm (src/lib/privacy/pseudonym.ts), damit
--      alte und neue Datensätze desselben Kunden weiter zusammenfinden.
--   2. Gelöscht werden: phone_raw, first_name, last_name, full_name.
--
-- Was sich NICHT ändert: Anzahl der Datensätze, Bestellungen, Umsätze, Straßen,
-- PLZ, Kundennummern, Zugriffsregeln, Rechte, andere Tabellen.
-- Die Spalten selbst bleiben bestehen (leer), damit ältere Programmstände
-- weiter funktionieren.
--
-- Zweiter Lauf: findet nichts mehr zu tun und ändert nichts.
-- =============================================================================
BEGIN;
DO $$
DECLARE
  n_before BIGINT; sum_orders_before NUMERIC; sum_rev_before NUMERIC;
  n_after BIGINT;  sum_orders_after NUMERIC;  sum_rev_after NUMERIC;
  keys_before BIGINT; keys_after BIGINT;
  n_phone INT; n_names INT;
BEGIN
  IF to_regclass('public.customers') IS NULL THEN
    RAISE EXCEPTION 'Abbruch: Tabelle customers fehlt. Es wurde nichts geändert.';
  END IF;

  SELECT count(*), coalesce(sum(total_orders),0), coalesce(sum(total_revenue),0) INTO n_before, sum_orders_before, sum_rev_before FROM public.customers;
  -- Anzahl verschiedener Kunden-Kennungen je Firma (darf sich nicht ändern)
  SELECT count(*) INTO keys_before FROM (SELECT DISTINCT company_id, phone_normalized FROM public.customers WHERE phone_normalized IS NOT NULL) x;

  UPDATE public.customers
     SET phone_normalized = 'p1:' || encode(sha256(convert_to(company_id::text || ':' || phone_normalized, 'UTF8')), 'hex')
   WHERE phone_normalized IS NOT NULL AND phone_normalized NOT LIKE 'p1:%';
  GET DIAGNOSTICS n_phone = ROW_COUNT;

  UPDATE public.customers
     SET phone_raw = NULL, first_name = NULL, last_name = NULL, full_name = NULL
   WHERE phone_raw IS NOT NULL OR first_name IS NOT NULL OR last_name IS NOT NULL OR full_name IS NOT NULL;
  GET DIAGNOSTICS n_names = ROW_COUNT;

  SELECT count(*), coalesce(sum(total_orders),0), coalesce(sum(total_revenue),0) INTO n_after, sum_orders_after, sum_rev_after FROM public.customers;
  SELECT count(*) INTO keys_after FROM (SELECT DISTINCT company_id, phone_normalized FROM public.customers WHERE phone_normalized IS NOT NULL) x;

  IF n_after <> n_before OR sum_orders_after <> sum_orders_before OR sum_rev_after <> sum_rev_before THEN
    RAISE EXCEPTION 'Abbruch: Datensätze, Bestellungen oder Umsatz hätten sich verändert. Es wurde nichts geändert.';
  END IF;
  IF keys_after <> keys_before THEN
    RAISE EXCEPTION 'Abbruch: Die Zahl der unterscheidbaren Kunden hätte sich verändert (% → %). Es wurde nichts geändert.', keys_before, keys_after;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE (phone_normalized IS NOT NULL AND phone_normalized NOT LIKE 'p1:%')
               OR phone_raw IS NOT NULL OR first_name IS NOT NULL OR last_name IS NOT NULL OR full_name IS NOT NULL) THEN
    RAISE EXCEPTION 'Abbruch: Es sind noch Klartextdaten vorhanden. Es wurde nichts geändert.';
  END IF;
  RAISE NOTICE 'Datenminimierung: % Telefonnummern ersetzt, % Datensätze von Namen/Rohnummern bereinigt, % Datensätze insgesamt unverändert in Bestellungen und Umsatz.', n_phone, n_names, n_after;
END $$;
COMMIT;

-- Kontrolle (nur lesen): alle drei Zahlen müssen 0 sein
SELECT count(*) FILTER (WHERE phone_normalized IS NOT NULL AND phone_normalized NOT LIKE 'p1:%') AS telefon_im_klartext,
       count(*) FILTER (WHERE phone_raw IS NOT NULL) AS rohnummern,
       count(*) FILTER (WHERE first_name IS NOT NULL OR last_name IS NOT NULL OR full_name IS NOT NULL) AS namen
FROM public.customers;
