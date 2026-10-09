-- =============================================================================
-- Gastro Intelligence Platform — Supabase Schema
-- Version: 1.0.0
-- Mandantenfähig (Multi-Tenant) mit Row Level Security (RLS)
-- DSGVO-konform
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- Fuzzy String Matching für Straßennamen
CREATE EXTENSION IF NOT EXISTS "postgis";  -- Geodaten (optional, für Kartenabfragen)

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
CREATE TYPE upload_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE data_source AS ENUM ('openplz', 'osm', 'census', 'google_places', 'opendata_city', 'manual', 'estimated');
CREATE TYPE data_trust_level AS ENUM ('official', 'public', 'estimated', 'manual');
CREATE TYPE street_class AS ENUM ('A', 'B', 'C', 'D', 'E');
CREATE TYPE alert_severity AS ENUM ('critical', 'warning', 'info');
CREATE TYPE action_type AS ENUM ('flyer', 'sms', 'app_campaign', 'b2b_visit', 'coupon', 'reactivation', 'loyalty');
CREATE TYPE rfm_segment AS ENUM ('vip', 'loyal', 'potential', 'at_risk', 'lost', 'new');
CREATE TYPE poi_category AS ENUM (
  'restaurant', 'competitor', 'hotel', 'school', 'hospital',
  'authority', 'fitness', 'office', 'commercial', 'supermarket', 'other'
);

-- =============================================================================
-- MANDANTEN: companies & users
-- =============================================================================

CREATE TABLE companies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'trial',     -- trial | starter | pro | enterprise
  plan_expires_at TIMESTAMPTZ,
  logo_url      TEXT,
  address       TEXT,
  city          TEXT,
  postal_code   TEXT,
  country       TEXT NOT NULL DEFAULT 'DE',
  phone         TEXT,
  email         TEXT,
  website       TEXT,
  google_places_api_key TEXT,                      -- Optional Google Places Key pro Mandant
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE company_users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        user_role NOT NULL DEFAULT 'viewer',
  invited_by  UUID REFERENCES auth.users(id),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, user_id)
);

CREATE INDEX idx_company_users_company ON company_users(company_id);
CREATE INDEX idx_company_users_user ON company_users(user_id);

-- =============================================================================
-- STORES (Filialen)
-- =============================================================================

CREATE TABLE stores (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT,
  postal_code   TEXT,
  city          TEXT,
  lat           DECIMAL(10, 7),
  lng           DECIMAL(10, 7),
  delivery_radius_km DECIMAL(5,2) DEFAULT 5.0,
  delivery_postal_codes TEXT[],    -- PLZ die dieser Store beliefert
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stores_company ON stores(company_id);

-- =============================================================================
-- UPLOADS
-- =============================================================================

CREATE TABLE uploads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id        UUID REFERENCES stores(id),
  uploaded_by     UUID NOT NULL REFERENCES auth.users(id),
  filename        TEXT NOT NULL,
  storage_path    TEXT NOT NULL,     -- Supabase Storage Pfad
  file_size_bytes BIGINT,
  file_type       TEXT,
  row_count       INTEGER,
  status          upload_status NOT NULL DEFAULT 'pending',
  column_mapping  JSONB,             -- Erkannte Spalten-Zuordnung
  error_message   TEXT,
  processed_at    TIMESTAMPTZ,
  period_start    DATE,              -- Berichtszeitraum Start
  period_end      DATE,              -- Berichtszeitraum Ende
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_uploads_company ON uploads(company_id);
CREATE INDEX idx_uploads_store ON uploads(store_id);

-- =============================================================================
-- KUNDEN (nach Bereinigung)
-- =============================================================================

CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id          UUID REFERENCES stores(id),
  upload_id         UUID REFERENCES uploads(id),

  -- Kontaktdaten
  phone_normalized  TEXT,            -- Normalisierte Telefonnummer
  phone_raw         TEXT,
  first_name        TEXT,
  last_name         TEXT,
  full_name         TEXT,

  -- Adresse
  street            TEXT,
  street_normalized TEXT,
  house_number      TEXT,
  postal_code       TEXT NOT NULL,
  city              TEXT,
  lat               DECIMAL(10,7),
  lng               DECIMAL(10,7),

  -- Bestellstatistiken
  total_orders      INTEGER NOT NULL DEFAULT 0,
  total_revenue     DECIMAL(10,2) NOT NULL DEFAULT 0,
  avg_order_value   DECIMAL(10,2),
  first_order_date  DATE,
  last_order_date   DATE,
  orders_last_30d   INTEGER DEFAULT 0,
  orders_last_90d   INTEGER DEFAULT 0,

  -- RFM Analyse
  rfm_recency_days  INTEGER,         -- Tage seit letzter Bestellung
  rfm_frequency     INTEGER,         -- Anzahl Bestellungen
  rfm_monetary      DECIMAL(10,2),   -- Gesamtumsatz
  rfm_score         INTEGER,         -- 1-5 Score
  rfm_segment       rfm_segment,

  -- Flags
  is_vip            BOOLEAN DEFAULT FALSE,
  is_active         BOOLEAN DEFAULT TRUE,
  platform          TEXT,            -- lieferando | wolt | uber_eats | own_app | phone
  late_deliveries   INTEGER DEFAULT 0,

  -- Duplikat-Handling
  is_duplicate      BOOLEAN DEFAULT FALSE,
  merged_into       UUID REFERENCES customers(id),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_company ON customers(company_id);
CREATE INDEX idx_customers_postal ON customers(postal_code);
CREATE INDEX idx_customers_street ON customers(street_normalized);
CREATE INDEX idx_customers_phone ON customers(phone_normalized);
CREATE INDEX idx_customers_rfm ON customers(rfm_segment);
CREATE INDEX idx_customers_store ON customers(store_id);

-- =============================================================================
-- REFERENZDATEN: Postleitzahlen (Deutschlandweit)
-- =============================================================================

CREATE TABLE postal_codes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code   TEXT NOT NULL UNIQUE,
  city          TEXT NOT NULL,
  state         TEXT,                -- Bundesland
  district      TEXT,               -- Landkreis
  municipality  TEXT,               -- Gemeinde
  lat           DECIMAL(10,7),
  lng           DECIMAL(10,7),
  bbox_south    DECIMAL(10,7),
  bbox_north    DECIMAL(10,7),
  bbox_west     DECIMAL(10,7),
  bbox_east     DECIMAL(10,7),

  -- Bevölkerungsdaten (Zensus 2022)
  population          INTEGER,
  households          INTEGER,
  population_density  DECIMAL(10,2),  -- EW/km²
  area_km2            DECIMAL(10,4),
  avg_household_size  DECIMAL(4,2),

  -- Datenqualität
  data_source         data_source NOT NULL DEFAULT 'openplz',
  trust_level         data_trust_level NOT NULL DEFAULT 'public',
  population_source   data_source,
  population_year     SMALLINT,
  last_fetched_at     TIMESTAMPTZ,
  needs_refresh       BOOLEAN DEFAULT FALSE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_postal_codes_plz ON postal_codes(postal_code);
CREATE INDEX idx_postal_codes_city ON postal_codes(city);
CREATE INDEX idx_postal_codes_state ON postal_codes(state);

-- =============================================================================
-- REFERENZDATEN: Straßen je PLZ
-- =============================================================================

CREATE TABLE streets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code     TEXT NOT NULL REFERENCES postal_codes(postal_code) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,      -- Normalisiert für Abgleich
  osm_id          BIGINT,
  street_type     TEXT,               -- residential | primary | secondary etc.
  lat_center      DECIMAL(10,7),
  lng_center      DECIMAL(10,7),
  data_source     data_source NOT NULL DEFAULT 'openplz',
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(postal_code, name_normalized)
);

CREATE INDEX idx_streets_postal ON streets(postal_code);
CREATE INDEX idx_streets_name ON streets USING gin(name gin_trgm_ops);
CREATE INDEX idx_streets_normalized ON streets(name_normalized);

-- =============================================================================
-- REFERENZDATEN: Points of Interest (OSM + Google Places)
-- =============================================================================

CREATE TABLE poi_businesses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code     TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        poi_category NOT NULL,
  subcategory     TEXT,              -- z.B. "pizza" | "burger" | "sushi"
  address         TEXT,
  street          TEXT,
  house_number    TEXT,
  city            TEXT,
  lat             DECIMAL(10,7) NOT NULL,
  lng             DECIMAL(10,7) NOT NULL,

  -- Details
  phone           TEXT,
  website         TEXT,
  rating          DECIMAL(3,2),      -- 1.0–5.0
  review_count    INTEGER,
  price_level     SMALLINT,          -- 1–4
  opening_hours   JSONB,
  is_chain        BOOLEAN DEFAULT FALSE,
  chain_name      TEXT,

  -- Wettbewerber-Flag
  is_competitor   BOOLEAN DEFAULT FALSE,
  delivery_platforms TEXT[],         -- ['lieferando', 'wolt', 'uber_eats']

  -- Quelldaten
  osm_id          BIGINT,
  google_place_id TEXT,
  data_source     data_source NOT NULL,
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_poi_postal ON poi_businesses(postal_code);
CREATE INDEX idx_poi_category ON poi_businesses(category);
CREATE INDEX idx_poi_competitor ON poi_businesses(is_competitor);
CREATE INDEX idx_poi_coords ON poi_businesses(lat, lng);

-- =============================================================================
-- ANALYSEN (pro Upload / Zeitraum)
-- =============================================================================

CREATE TABLE analytics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id        UUID REFERENCES stores(id),
  upload_id       UUID REFERENCES uploads(id),
  postal_code     TEXT,

  -- Zeitraum
  period_start    DATE,
  period_end      DATE,

  -- PLZ-Ebene
  customer_count          INTEGER,
  order_count             INTEGER,
  revenue                 DECIMAL(12,2),
  avg_order_value         DECIMAL(10,2),
  orders_per_customer     DECIMAL(5,2),
  population              INTEGER,
  market_penetration_pct  DECIMAL(6,3),   -- Kunden / Einwohner * 100
  not_reached_residents   INTEGER,

  -- Straßen-Ebene
  streets_total           INTEGER,
  streets_with_orders     INTEGER,
  streets_without_orders  INTEGER,
  streets_coverage_pct    DECIMAL(6,2),

  -- Kunden-Segmente
  one_time_buyers         INTEGER,
  repeat_customers        INTEGER,
  vip_customers           INTEGER,
  lost_customers          INTEGER,
  new_customers           INTEGER,
  reactivated_customers   INTEGER,

  -- Qualität
  late_delivery_pct       DECIMAL(5,2),
  vip_usage_pct           DECIMAL(5,2),

  -- Potenzial-Szenarien (JSON)
  potential_scenarios     JSONB,   -- [{pct:5, new_customers:X, revenue:Y}, ...]

  -- ROI Empfehlungen (JSON)
  top_recommendations     JSONB,

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_analytics_company ON analytics(company_id);
CREATE INDEX idx_analytics_postal ON analytics(postal_code);
CREATE INDEX idx_analytics_store ON analytics(store_id);
CREATE INDEX idx_analytics_period ON analytics(period_start, period_end);

-- =============================================================================
-- STRASSEN-ANALYSE (detailliert pro Straße)
-- =============================================================================

CREATE TABLE street_analytics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  analytics_id    UUID NOT NULL REFERENCES analytics(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  postal_code     TEXT NOT NULL,
  street_name     TEXT NOT NULL,
  street_name_normalized TEXT NOT NULL,

  customer_count  INTEGER NOT NULL DEFAULT 0,
  order_count     INTEGER NOT NULL DEFAULT 0,
  revenue         DECIMAL(10,2) NOT NULL DEFAULT 0,
  avg_order_value DECIMAL(10,2),
  orders_per_customer DECIMAL(5,2),

  -- Klassifikation
  street_class    street_class,      -- A B C D E
  is_in_official_list BOOLEAN DEFAULT TRUE,

  -- Trend
  trend_vs_prev_period DECIMAL(5,2), -- % Veränderung
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_street_analytics_analytics ON street_analytics(analytics_id);
CREATE INDEX idx_street_analytics_company ON street_analytics(company_id);
CREATE INDEX idx_street_analytics_postal ON street_analytics(postal_code);

-- =============================================================================
-- MARKETING AKTIONEN
-- =============================================================================

CREATE TABLE marketing_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id        UUID REFERENCES stores(id),
  analytics_id    UUID REFERENCES analytics(id),

  action_type     action_type NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  target_postal_codes TEXT[],
  target_streets  TEXT[],
  target_segments rfm_segment[],

  -- ROI Kalkulation
  estimated_cost      DECIMAL(10,2),
  estimated_potential DECIMAL(10,2),
  estimated_roi       DECIMAL(8,2),
  estimated_new_customers INTEGER,
  priority            SMALLINT DEFAULT 3,  -- 1=highest, 5=lowest

  -- Ausführung
  status          TEXT DEFAULT 'recommended',  -- recommended | planned | active | completed
  scheduled_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  actual_cost     DECIMAL(10,2),
  actual_revenue  DECIMAL(10,2),
  actual_roi      DECIMAL(8,2),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_marketing_company ON marketing_actions(company_id);
CREATE INDEX idx_marketing_type ON marketing_actions(action_type);

-- =============================================================================
-- FRÜHWARNUNGEN
-- =============================================================================

CREATE TABLE alerts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id        UUID REFERENCES stores(id),

  severity        alert_severity NOT NULL,
  category        TEXT NOT NULL,     -- revenue | customers | delivery | vip | plz
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  metric_value    DECIMAL(12,2),
  threshold_value DECIMAL(12,2),
  change_pct      DECIMAL(6,2),

  is_resolved     BOOLEAN DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES auth.users(id),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_company ON alerts(company_id);
CREATE INDEX idx_alerts_severity ON alerts(severity);
CREATE INDEX idx_alerts_resolved ON alerts(is_resolved);

-- =============================================================================
-- DATEN-REFRESH LOGS
-- =============================================================================

CREATE TABLE data_refresh_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code     TEXT,
  data_type       TEXT NOT NULL,   -- streets | poi | population | competitors
  data_source     data_source NOT NULL,
  status          TEXT NOT NULL,   -- success | failed | partial
  records_fetched INTEGER,
  records_inserted INTEGER,
  records_updated INTEGER,
  error_message   TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_logs_postal ON data_refresh_logs(postal_code);
CREATE INDEX idx_refresh_logs_type ON data_refresh_logs(data_type);

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) — Mandantenfähigkeit
-- =============================================================================

ALTER TABLE companies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_users     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores            ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics         ENABLE ROW LEVEL SECURITY;
ALTER TABLE street_analytics  ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts            ENABLE ROW LEVEL SECURITY;

-- Referenzdaten sind öffentlich lesbar (kein RLS)
-- postal_codes, streets, poi_businesses, data_refresh_logs

-- ── Hilfsfunktion: aktuell angemeldete company_id des Users ──────────────────
CREATE OR REPLACE FUNCTION get_my_company_id()
RETURNS UUID AS $$
  SELECT company_id FROM company_users
  WHERE user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_company_member(cid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_users
    WHERE user_id = auth.uid() AND company_id = cid
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION my_company_role()
RETURNS user_role AS $$
  SELECT role FROM company_users
  WHERE user_id = auth.uid()
  ORDER BY
    CASE role
      WHEN 'owner'   THEN 1
      WHEN 'admin'   THEN 2
      WHEN 'manager' THEN 3
      WHEN 'viewer'  THEN 4
    END
  LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ── RLS Policies ─────────────────────────────────────────────────────────────

-- companies: nur eigene Firma sehen
CREATE POLICY "companies_select" ON companies FOR SELECT
  USING (is_company_member(id));
CREATE POLICY "companies_update" ON companies FOR UPDATE
  USING (is_company_member(id) AND my_company_role() IN ('owner', 'admin'));

-- company_users: nur eigene Firma
CREATE POLICY "company_users_select" ON company_users FOR SELECT
  USING (company_id = get_my_company_id());
CREATE POLICY "company_users_insert" ON company_users FOR INSERT
  WITH CHECK (company_id = get_my_company_id() AND my_company_role() IN ('owner', 'admin'));
CREATE POLICY "company_users_delete" ON company_users FOR DELETE
  USING (company_id = get_my_company_id() AND my_company_role() IN ('owner', 'admin'));

-- stores
CREATE POLICY "stores_all" ON stores FOR ALL
  USING (company_id = get_my_company_id());

-- uploads
CREATE POLICY "uploads_all" ON uploads FOR ALL
  USING (company_id = get_my_company_id());

-- customers
CREATE POLICY "customers_all" ON customers FOR ALL
  USING (company_id = get_my_company_id());

-- analytics
CREATE POLICY "analytics_all" ON analytics FOR ALL
  USING (company_id = get_my_company_id());

-- street_analytics
CREATE POLICY "street_analytics_all" ON street_analytics FOR ALL
  USING (company_id = get_my_company_id());

-- marketing_actions
CREATE POLICY "marketing_all" ON marketing_actions FOR ALL
  USING (company_id = get_my_company_id());

-- alerts
CREATE POLICY "alerts_all" ON alerts FOR ALL
  USING (company_id = get_my_company_id());

-- =============================================================================
-- FUNCTIONS & TRIGGERS
-- =============================================================================

-- updated_at automatisch setzen
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_updated_at     BEFORE UPDATE ON companies     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_stores_updated_at        BEFORE UPDATE ON stores        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_customers_updated_at     BEFORE UPDATE ON customers     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_marketing_updated_at     BEFORE UPDATE ON marketing_actions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Neue Company: ersten User als Owner eintragen
CREATE OR REPLACE FUNCTION on_auth_user_created()
RETURNS TRIGGER AS $$
BEGIN
  -- Wird vom Frontend nach company creation aufgerufen
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- SUPABASE STORAGE BUCKETS
-- =============================================================================

-- Bucket für Uploads (privat)
INSERT INTO storage.buckets (id, name, public) VALUES ('uploads', 'uploads', FALSE);

-- Storage RLS: nur eigene Company-Uploads
CREATE POLICY "uploads_storage_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'uploads' AND auth.uid() IS NOT NULL);

CREATE POLICY "uploads_storage_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'uploads' AND auth.uid() IS NOT NULL);
