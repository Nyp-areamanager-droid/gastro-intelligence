-- =============================================================================
-- Testnachbau der Produktion (Stand Lese-Abfrage 06.11.2026)
-- Wird NACH SETUP_DATABASE.sql geladen. Nur für migration-test.mjs.
-- =============================================================================

-- In Produktion vorhanden, steht aber nur in 001_initial_schema.sql
CREATE TABLE IF NOT EXISTS data_refresh_logs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code      TEXT,
  data_type        TEXT NOT NULL,
  data_source      data_source NOT NULL,
  status           TEXT NOT NULL,
  records_fetched  INTEGER DEFAULT 0,
  error_message    TEXT,
  duration_ms      INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- In Produktion von Hand angelegt (laut Lese-Abfrage)
CREATE POLICY "company_users_insert_own" ON company_users FOR INSERT WITH CHECK (user_id = auth.uid());

-- In Produktion vorhanden (zweite Lese-Abfrage: on_auth_user_created() → trigger,
-- SECURITY DEFINER). Inhalt hier mit Erkennungszeichen, damit der Test prüft,
-- dass 002 ihn nicht verändert.
CREATE OR REPLACE FUNCTION on_auth_user_created()
RETURNS TRIGGER AS $$
BEGIN
  -- Erkennungszeichen: ORIGINAL-INHALT-PRODUKTION
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
