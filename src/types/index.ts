// =============================================================================
// Gastro Intelligence Platform — TypeScript Types
// =============================================================================

// ── Enums ─────────────────────────────────────────────────────────────────────

export type UserRole = 'owner' | 'admin' | 'manager' | 'viewer'
export type UploadStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type DataSource = 'openplz' | 'osm' | 'census' | 'google_places' | 'opendata_city' | 'manual' | 'estimated'
export type DataTrustLevel = 'official' | 'public' | 'estimated' | 'manual'
export type StreetClass = 'A' | 'B' | 'C' | 'D' | 'E'
export type AlertSeverity = 'critical' | 'warning' | 'info'
export type ActionType = 'flyer' | 'sms' | 'app_campaign' | 'b2b_visit' | 'coupon' | 'reactivation' | 'loyalty'
export type RFMSegment = 'vip' | 'loyal' | 'potential' | 'at_risk' | 'lost' | 'new'
export type POICategory = 'restaurant' | 'competitor' | 'hotel' | 'school' | 'hospital' | 'authority' | 'fitness' | 'office' | 'commercial' | 'supermarket' | 'other'

// ── Database Entities ─────────────────────────────────────────────────────────

export interface Company {
  id: string
  name: string
  slug: string
  plan: string
  plan_expires_at?: string
  logo_url?: string
  address?: string
  city?: string
  postal_code?: string
  country: string
  phone?: string
  email?: string
  website?: string
  google_places_api_key?: string
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CompanyUser {
  id: string
  company_id: string
  user_id: string
  role: UserRole
  invited_by?: string
  joined_at: string
}

export interface Store {
  id: string
  company_id: string
  name: string
  address?: string
  postal_code?: string
  city?: string
  lat?: number
  lng?: number
  delivery_radius_km: number
  delivery_postal_codes?: string[]
  is_active: boolean
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface Upload {
  id: string
  company_id: string
  store_id?: string
  uploaded_by: string
  filename: string
  storage_path: string
  file_size_bytes?: number
  file_type?: string
  row_count?: number
  status: UploadStatus
  column_mapping?: ColumnMapping
  error_message?: string
  processed_at?: string
  period_start?: string
  period_end?: string
  created_at: string
}

export interface Customer {
  id: string
  company_id: string
  store_id?: string
  upload_id?: string
  phone_normalized?: string
  phone_raw?: string
  first_name?: string
  last_name?: string
  full_name?: string
  street?: string
  street_normalized?: string
  house_number?: string
  postal_code: string
  city?: string
  lat?: number
  lng?: number
  total_orders: number
  total_revenue: number
  avg_order_value?: number
  first_order_date?: string
  last_order_date?: string
  orders_last_30d?: number
  orders_last_90d?: number
  rfm_recency_days?: number
  rfm_frequency?: number
  rfm_monetary?: number
  rfm_score?: number
  rfm_segment?: RFMSegment
  is_vip: boolean
  is_active: boolean
  platform?: string
  late_deliveries?: number
  is_duplicate: boolean
  merged_into?: string
  created_at: string
  updated_at: string
}

export interface PostalCode {
  id: string
  postal_code: string
  city: string
  state?: string
  district?: string
  municipality?: string
  lat?: number
  lng?: number
  bbox_south?: number
  bbox_north?: number
  bbox_west?: number
  bbox_east?: number
  population?: number
  households?: number
  population_density?: number
  area_km2?: number
  avg_household_size?: number
  data_source: DataSource
  trust_level: DataTrustLevel
  population_source?: DataSource
  population_year?: number
  last_fetched_at?: string
  needs_refresh: boolean
  created_at: string
  updated_at: string
}

export interface Street {
  id: string
  postal_code: string
  name: string
  name_normalized: string
  osm_id?: number
  street_type?: string
  lat_center?: number
  lng_center?: number
  data_source: DataSource
  last_fetched_at: string
  created_at: string
}

export interface POIBusiness {
  id: string
  postal_code: string
  name: string
  category: POICategory
  subcategory?: string
  address?: string
  street?: string
  house_number?: string
  city?: string
  lat: number
  lng: number
  phone?: string
  website?: string
  rating?: number
  review_count?: number
  price_level?: number
  opening_hours?: Record<string, string>
  is_chain: boolean
  chain_name?: string
  is_competitor: boolean
  delivery_platforms?: string[]
  osm_id?: number
  google_place_id?: string
  data_source: DataSource
  last_fetched_at: string
  created_at: string
}

export interface Analytics {
  id: string
  company_id: string
  store_id?: string
  upload_id?: string
  postal_code?: string
  period_start?: string
  period_end?: string
  customer_count?: number
  order_count?: number
  revenue?: number
  avg_order_value?: number
  orders_per_customer?: number
  population?: number
  market_penetration_pct?: number
  not_reached_residents?: number
  streets_total?: number
  streets_with_orders?: number
  streets_without_orders?: number
  streets_coverage_pct?: number
  one_time_buyers?: number
  repeat_customers?: number
  vip_customers?: number
  lost_customers?: number
  new_customers?: number
  reactivated_customers?: number
  late_delivery_pct?: number
  vip_usage_pct?: number
  potential_scenarios?: PotentialScenario[]
  top_recommendations?: MarketingRecommendation[]
  computed_at: string
  created_at: string
}

export interface StreetAnalytic {
  id: string
  analytics_id: string
  company_id: string
  postal_code: string
  street_name: string
  street_name_normalized: string
  customer_count: number
  order_count: number
  revenue: number
  avg_order_value?: number
  orders_per_customer?: number
  street_class?: StreetClass
  is_in_official_list: boolean
  trend_vs_prev_period?: number
  created_at: string
}

export interface Alert {
  id: string
  company_id: string
  store_id?: string
  severity: AlertSeverity
  category: string
  title: string
  message: string
  metric_value?: number
  threshold_value?: number
  change_pct?: number
  is_resolved: boolean
  resolved_at?: string
  resolved_by?: string
  created_at: string
}

export interface MarketingAction {
  id: string
  company_id: string
  store_id?: string
  analytics_id?: string
  action_type: ActionType
  title: string
  description?: string
  target_postal_codes?: string[]
  target_streets?: string[]
  target_segments?: RFMSegment[]
  estimated_cost?: number
  estimated_potential?: number
  estimated_roi?: number
  estimated_new_customers?: number
  priority: number
  status: string
  scheduled_at?: string
  completed_at?: string
  actual_cost?: number
  actual_revenue?: number
  actual_roi?: number
  created_at: string
  updated_at: string
}

// ── Analysis Types ────────────────────────────────────────────────────────────

export interface PLZAnalysisResult {
  postal_code: string
  city: string
  state?: string
  // Kundendaten
  customer_count: number
  order_count: number
  revenue: number
  avg_order_value: number
  orders_per_customer: number
  // Bevölkerung
  population: number | null
  households: number | null
  population_source: DataSource | null
  // Marktdurchdringung
  market_penetration_pct: number | null
  not_reached_residents: number | null
  not_reached_pct: number | null
  // Straßen
  streets_total: number
  streets_with_orders: number
  streets_without_orders: number
  streets_coverage_pct: number
  // Potenzial
  flyer_potential_eur: number | null
  potential_scenarios: PotentialScenario[]
  // Segmente
  one_time_buyers: number
  repeat_customers: number
  vip_customers: number
  // Warnungen
  warnings: string[]
  // POIs
  poi_summary: POISummary
}

export interface PotentialScenario {
  target_penetration_pct: number
  additional_customers: number
  additional_orders: number
  additional_revenue: number
}

export interface POISummary {
  competitors: number
  hotels: number
  schools: number
  hospitals: number
  offices: number
  restaurants: number
  total_b2b_targets: number
}

export interface StreetAnalysisResult {
  street_name: string
  postal_code: string
  customer_count: number
  order_count: number
  revenue: number
  avg_order_value: number
  orders_per_customer: number
  street_class: StreetClass
  is_in_official_list: boolean
  recommendation: string
}

export interface MarketingRecommendation {
  action_type: ActionType
  title: string
  description: string
  target: string
  estimated_cost: number
  estimated_potential: number
  roi: number
  priority: number
  timeframe: string
}

export interface RFMAnalysis {
  segment: RFMSegment
  count: number
  pct: number
  avg_revenue: number
  avg_orders: number
  recommended_action: string
}

// ── Upload / Import Types ─────────────────────────────────────────────────────

export interface ColumnMapping {
  phone?: string
  first_name?: string
  last_name?: string
  street?: string
  house_number?: string
  postal_code?: string
  city?: string
  total_orders?: string
  total_revenue?: string
  avg_order_value?: string
  last_order_date?: string
  platform?: string
  store?: string
  late_deliveries?: string
  is_vip?: string
}

export interface ParsedCustomerRow {
  phone_raw?: string
  phone_normalized?: string
  first_name?: string
  last_name?: string
  full_name?: string
  street?: string
  street_normalized?: string
  house_number?: string
  postal_code?: string
  city?: string
  total_orders: number
  total_revenue: number
  avg_order_value?: number
  last_order_date?: string
  platform?: string
  late_deliveries?: number
  is_vip?: boolean
  rfm_score?: number
  rfm_segment?: RFMSegment
  _row_index: number
  _errors: string[]
}

export interface ImportSummary {
  total_rows: number
  valid_rows: number
  duplicate_rows: number
  error_rows: number
  unique_postal_codes: string[]
  unique_streets: number
  date_range: { start: string | null; end: string | null }
}

// ── Provider Types ────────────────────────────────────────────────────────────

export interface OpenPLZStreet {
  name: string
  postalCode: string
  locality: string
  municipality?: string
  district?: string
  federalState?: string
}

export interface OSMPOIResult {
  osm_id: number
  name: string
  category: string
  lat: number
  lng: number
  address?: {
    road?: string
    house_number?: string
    postcode?: string
    city?: string
  }
  tags?: Record<string, string>
}

export interface CensusData {
  postal_code: string
  population: number
  households?: number
  year: number
  source: DataSource
  trust_level: DataTrustLevel
}

// ── Dashboard Types ───────────────────────────────────────────────────────────

export interface DashboardKPIs {
  total_customers: number
  total_orders: number
  total_revenue: number
  avg_order_value: number
  repeat_rate_pct: number
  vip_rate_pct: number
  late_delivery_pct: number
  active_plz_count: number
  top_plz: string
  top_street: string
  critical_alerts: number
}

export interface TrendData {
  label: string
  customers: number
  orders: number
  revenue: number
  avg_bon: number
}

// ── Map Types ─────────────────────────────────────────────────────────────────

export type MapLayerType = 'customers' | 'streets' | 'competitors' | 'b2b' | 'heatmap'

export interface MapMarker {
  id: string
  lat: number
  lng: number
  type: POICategory | 'customer' | 'store'
  label: string
  color: string
  data?: Record<string, unknown>
}

export interface MapStreetFeature {
  street_name: string
  postal_code: string
  class: StreetClass | 'none'
  color: string
  customer_count: number
  order_count: number
}
