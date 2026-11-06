-- =============================================================================
-- ENTWURF – NICHT ANWENDEN OHNE FREIGABE
-- 003: Registrierung ohne Service-Key
--
-- Legt die Funktion public.register_company an. Mit ihr legt ein angemeldeter
-- Nutzer seine EIGENE Firma samt owner-Zuordnung an, ohne dass der Server den
-- Service-Key braucht. Sie ersetzt die Firmenanlage mit Service-Key in
-- /api/auth/complete-registration.
--
-- Was die Funktion darf – und was nicht:
--   - nur für den Aufrufer selbst (auth.uid()), nie für andere Nutzer
--   - nur wenn er noch keiner Firma angehört; sonst gibt sie die vorhandene
--     Firma zurück und ändert nichts (idempotent)
--   - Firma und owner-Zuordnung in EINER Transaktion; gleichzeitige Aufrufe
--     desselben Nutzers werden gesperrt (keine doppelte Firma)
--   - nicht ausführbar ohne Login (anon), nur für authenticated
--   - kein Zugriff auf bestehende Firmen anderer Nutzer
--
-- Rein ergänzend: ändert keine Tabelle, keine Regel, keine Daten.
-- Reihenfolge: VOR dem Deployment des Codes, der die Funktion aufruft.
-- Rückfall: DROP FUNCTION public.register_company(text, text);
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.register_company(p_name TEXT, p_slug TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  uid      UUID := auth.uid();
  nm       TEXT := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  sl       TEXT := lower(coalesce(p_slug, ''));
  existing UUID;
  cid      UUID;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Nicht angemeldet' USING ERRCODE = '28000';
  END IF;
  IF length(nm) < 2 OR length(nm) > 100 THEN
    RAISE EXCEPTION 'Unternehmensname muss zwischen 2 und 100 Zeichen lang sein' USING ERRCODE = '22023';
  END IF;
  IF sl !~ '^[a-z0-9-]{1,80}$' THEN
    RAISE EXCEPTION 'Ungültiger Kurzname' USING ERRCODE = '22023';
  END IF;

  -- Gleichzeitige Aufrufe desselben Nutzers nacheinander abarbeiten
  PERFORM pg_advisory_xact_lock(hashtextextended('register_company:' || uid::text, 0));

  SELECT company_id INTO existing
  FROM public.company_users
  WHERE user_id = uid
  ORDER BY joined_at ASC, company_id ASC
  LIMIT 1;
  IF existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_registered', 'company_id', existing);
  END IF;

  -- Kurzname eindeutig machen, falls schon vergeben
  IF EXISTS (SELECT 1 FROM public.companies WHERE slug = sl) THEN
    sl := left(sl, 70) || '-' || substr(md5(random()::text), 1, 8);
  END IF;

  INSERT INTO public.companies (name, slug, plan) VALUES (nm, sl, 'trial') RETURNING id INTO cid;
  INSERT INTO public.company_users (company_id, user_id, role) VALUES (cid, uid, 'owner');

  RETURN jsonb_build_object('status', 'created', 'company_id', cid);
END;
$$;

REVOKE ALL ON FUNCTION public.register_company(TEXT, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.register_company(TEXT, TEXT) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.register_company(TEXT, TEXT) TO authenticated';
  END IF;
END $$;

COMMIT;
