-- Gastro Intelligence Platform — Datenbank Setup
-- Einmalig im Supabase SQL Editor ausführen

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ENUM TYPES
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'viewer');
CREATE TYPE upload_status AS ENUM ('pending', 'processing', 'completed', 'failed');
CREATE TYPE data_source AS ENUM ('openplz', 'osm', 'census', 'google_places', 'opendata_city', 'manual', 'estimated');
CREATE TYPE data_trust_level AS ENUM ('official', 'public', 'estimated', 'manual');
CREATE TYPE street_class AS ENUM ('A', 'B', 'C', 'D', 'E');
CREATE TYPE alert_severity AS ENUM ('critical', 'warning', 'info');
CREATE TYPE action_type AS ENUM ('flyer', 'sms', 'app_campaign', 'b2b_visit', 'coupon', 'reactivation', 'loyalty');
CREATE TYPE rfm_segment AS ENUM ('vip', 'loyal', 'potential', 'at_risk', 'lost', 'new');
CREATE TYPE poi_category AS ENUM ('restaurant', 'competitor', 'hotel', 'school', 'hospital', 'authority', 'fitness', 'office', 'commercial', 'supermarket', 'other');

-- COMPANIES
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'trial',
  plan_expires_at TIMESTAMPTZ,
  logo_url TEXT,
  address TEXT, city TEXT, postal_code TEXT,
  country TEXT NOT NULL DEFAULT 'DE',
  phone TEXT, email TEXT, website TEXT,
  google_places_api_key TEXT,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- COMPANY USERS
CREATE TABLE company_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role user_role NOT NULL DEFAULT 'viewer',
  invited_by UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, user_id)
);
CREATE INDEX idx_company_users_company ON company_users(company_id);
CREATE INDEX idx_company_users_user ON company_users(user_id);

-- STORES
CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, address TEXT, postal_code TEXT, city TEXT,
  lat DECIMAL(10,7), lng DECIMAL(10,7),
  delivery_radius_km DECIMAL(5,2) DEFAULT 5.0,
  delivery_postal_codes TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stores_company ON stores(company_id);

-- UPLOADS
CREATE TABLE uploads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id),
  uploaded_by UUID NOT NULL REFERENCES auth.users(id),
  filename TEXT NOT NULL, storage_path TEXT NOT NULL,
  file_size_bytes BIGINT, file_type TEXT, row_count INTEGER,
  status upload_status NOT NULL DEFAULT 'pending',
  column_mapping JSONB, error_message TEXT, processed_at TIMESTAMPTZ,
  period_start DATE, period_end DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_uploads_company ON uploads(company_id);

-- CUSTOMERS
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id),
  upload_id UUID REFERENCES uploads(id),
  phone_normalized TEXT, phone_raw TEXT,
  first_name TEXT, last_name TEXT, full_name TEXT,
  street TEXT, street_normalized TEXT, house_number TEXT,
  postal_code TEXT NOT NULL, city TEXT,
  lat DECIMAL(10,7), lng DECIMAL(10,7),
  total_orders INTEGER NOT NULL DEFAULT 0,
  total_revenue DECIMAL(10,2) NOT NULL DEFAULT 0,
  avg_order_value DECIMAL(10,2),
  first_order_date DATE, last_order_date DATE,
  orders_last_30d INTEGER DEFAULT 0, orders_last_90d INTEGER DEFAULT 0,
  rfm_recency_days INTEGER, rfm_frequency INTEGER,
  rfm_monetary DECIMAL(10,2), rfm_score INTEGER,
  rfm_segment rfm_segment,
  is_vip BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE,
  platform TEXT, late_deliveries INTEGER DEFAULT 0,
  is_duplicate BOOLEAN DEFAULT FALSE, merged_into UUID REFERENCES customers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_customers_company ON customers(company_id);
CREATE INDEX idx_customers_postal ON customers(postal_code);

-- POSTAL CODES
CREATE TABLE postal_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code TEXT NOT NULL UNIQUE, city TEXT NOT NULL,
  state TEXT, district TEXT, municipality TEXT,
  lat DECIMAL(10,7), lng DECIMAL(10,7),
  bbox_south DECIMAL(10,7), bbox_north DECIMAL(10,7),
  bbox_west DECIMAL(10,7), bbox_east DECIMAL(10,7),
  population INTEGER, households INTEGER,
  population_density DECIMAL(10,2), area_km2 DECIMAL(10,4),
  avg_household_size DECIMAL(4,2),
  data_source data_source NOT NULL DEFAULT 'openplz',
  trust_level data_trust_level NOT NULL DEFAULT 'public',
  population_source data_source, population_year SMALLINT,
  last_fetched_at TIMESTAMPTZ, needs_refresh BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_postal_codes_plz ON postal_codes(postal_code);

-- STREETS
CREATE TABLE streets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code TEXT NOT NULL REFERENCES postal_codes(postal_code) ON DELETE CASCADE,
  name TEXT NOT NULL, name_normalized TEXT NOT NULL,
  osm_id BIGINT, street_type TEXT,
  lat_center DECIMAL(10,7), lng_center DECIMAL(10,7),
  data_source data_source NOT NULL DEFAULT 'openplz',
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(postal_code, name_normalized)
);
CREATE INDEX idx_streets_postal ON streets(postal_code);
CREATE INDEX idx_streets_name ON streets USING gin(name gin_trgm_ops);

-- POI BUSINESSES
CREATE TABLE poi_businesses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  postal_code TEXT NOT NULL, name TEXT NOT NULL,
  category poi_category NOT NULL, subcategory TEXT,
  address TEXT, street TEXT, house_number TEXT, city TEXT,
  lat DECIMAL(10,7) NOT NULL, lng DECIMAL(10,7) NOT NULL,
  phone TEXT, website TEXT, rating DECIMAL(3,2),
  review_count INTEGER, price_level SMALLINT,
  opening_hours JSONB, is_chain BOOLEAN DEFAULT FALSE, chain_name TEXT,
  is_competitor BOOLEAN DEFAULT FALSE, delivery_platforms TEXT[],
  osm_id BIGINT, google_place_id TEXT,
  data_source data_source NOT NULL,
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_poi_postal ON poi_businesses(postal_code);
CREATE INDEX idx_poi_category ON poi_businesses(category);

-- ANALYTICS
CREATE TABLE analytics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id), upload_id UUID REFERENCES uploads(id),
  postal_code TEXT, period_start DATE, period_end DATE,
  customer_count INTEGER, order_count INTEGER,
  revenue DECIMAL(12,2), avg_order_value DECIMAL(10,2),
  orders_per_customer DECIMAL(5,2), population INTEGER,
  market_penetration_pct DECIMAL(6,3), not_reached_residents INTEGER,
  streets_total INTEGER, streets_with_orders INTEGER,
  streets_without_orders INTEGER, streets_coverage_pct DECIMAL(6,2),
  one_time_buyers INTEGER, repeat_customers INTEGER,
  vip_customers INTEGER, lost_customers INTEGER,
  new_customers INTEGER, reactivated_customers INTEGER,
  late_delivery_pct DECIMAL(5,2), vip_usage_pct DECIMAL(5,2),
  potential_scenarios JSONB, top_recommendations JSONB,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_analytics_company ON analytics(company_id);
CREATE INDEX idx_analytics_postal ON analytics(postal_code);

-- STREET ANALYTICS
CREATE TABLE street_analytics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  analytics_id UUID NOT NULL REFERENCES analytics(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  postal_code TEXT NOT NULL, street_name TEXT NOT NULL,
  street_name_normalized TEXT NOT NULL,
  customer_count INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  revenue DECIMAL(10,2) NOT NULL DEFAULT 0,
  avg_order_value DECIMAL(10,2), orders_per_customer DECIMAL(5,2),
  street_class street_class, is_in_official_list BOOLEAN DEFAULT TRUE,
  trend_vs_prev_period DECIMAL(5,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_street_analytics_company ON street_analytics(company_id);

-- MARKETING ACTIONS
CREATE TABLE marketing_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id), analytics_id UUID REFERENCES analytics(id),
  action_type action_type NOT NULL, title TEXT NOT NULL, description TEXT,
  target_postal_codes TEXT[], target_streets TEXT[], target_segments rfm_segment[],
  estimated_cost DECIMAL(10,2), estimated_potential DECIMAL(10,2),
  estimated_roi DECIMAL(8,2), estimated_new_customers INTEGER,
  priority SMALLINT DEFAULT 3, status TEXT DEFAULT 'recommended',
  scheduled_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  actual_cost DECIMAL(10,2), actual_revenue DECIMAL(10,2), actual_roi DECIMAL(8,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_marketing_company ON marketing_actions(company_id);

-- ALERTS
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id),
  severity alert_severity NOT NULL, category TEXT NOT NULL,
  title TEXT NOT NULL, message TEXT NOT NULL,
  metric_value DECIMAL(12,2), threshold_value DECIMAL(12,2), change_pct DECIMAL(6,2),
  is_resolved BOOLEAN DEFAULT FALSE, resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_alerts_company ON alerts(company_id);

-- RLS AKTIVIEREN
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE street_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

-- HILFSFUNKTIONEN
CREATE OR REPLACE FUNCTION get_my_company_id() RETURNS UUID AS $$
  SELECT company_id FROM company_users WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_company_member(cid UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM company_users WHERE user_id = auth.uid() AND company_id = cid);
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION my_company_role() RETURNS user_role AS $$
  SELECT role FROM company_users WHERE user_id = auth.uid()
  ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'manager' THEN 3 ELSE 4 END LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- RLS POLICIES
CREATE POLICY "companies_select" ON companies FOR SELECT USING (is_company_member(id));
CREATE POLICY "companies_insert" ON companies FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "companies_update" ON companies FOR UPDATE USING (is_company_member(id));

CREATE POLICY "company_users_select" ON company_users FOR SELECT USING (company_id = get_my_company_id() OR user_id = auth.uid());
CREATE POLICY "company_users_insert" ON company_users FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "company_users_delete" ON company_users FOR DELETE USING (company_id = get_my_company_id());

CREATE POLICY "stores_all" ON stores FOR ALL USING (company_id = get_my_company_id());
CREATE POLICY "uploads_all" ON uploads FOR ALL USING (company_id = get_my_company_id());
CREATE POLICY "customers_all" ON customers FOR ALL USING (company_id = get_my_company_id());
CREATE POLICY "analytics_all" ON analytics FOR ALL USING (company_id = get_my_company_id());
CREATE POLICY "street_analytics_all" ON street_analytics FOR ALL USING (company_id = get_my_company_id());
CREATE POLICY "marketing_all" ON marketing_actions FOR ALL USING (company_id = get_my_company_id());
CREATE POLICY "alerts_all" ON alerts FOR ALL USING (company_id = get_my_company_id());

-- TRIGGERS
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_stores_updated_at BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_marketing_updated_at BEFORE UPDATE ON marketing_actions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- STORAGE BUCKET
INSERT INTO storage.buckets (id, name, public) VALUES ('uploads', 'uploads', FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "uploads_storage_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'uploads' AND auth.uid() IS NOT NULL);
CREATE POLICY "uploads_storage_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'uploads' AND auth.uid() IS NOT NULL);
