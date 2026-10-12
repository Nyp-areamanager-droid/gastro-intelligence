// =============================================================================
// Gastro Intelligence Platform — Supabase Database Types
// Auto-generated from schema — do not edit manually
// Run: npx supabase gen types typescript --project-id <id> > src/lib/supabase/database.types.ts
// =============================================================================

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      companies: {
        Row: {
          id: string
          name: string
          slug: string
          plan: string
          plan_expires_at: string | null
          logo_url: string | null
          address: string | null
          city: string | null
          postal_code: string | null
          country: string
          phone: string | null
          email: string | null
          website: string | null
          google_places_api_key: string | null
          settings: Json
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          plan?: string
          plan_expires_at?: string | null
          logo_url?: string | null
          address?: string | null
          city?: string | null
          postal_code?: string | null
          country?: string
          phone?: string | null
          email?: string | null
          website?: string | null
          google_places_api_key?: string | null
          settings?: Json
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          plan?: string
          plan_expires_at?: string | null
          logo_url?: string | null
          address?: string | null
          city?: string | null
          postal_code?: string | null
          country?: string
          phone?: string | null
          email?: string | null
          website?: string | null
          google_places_api_key?: string | null
          settings?: Json
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      company_users: {
        Row: {
          id: string
          company_id: string
          user_id: string
          role: Database['public']['Enums']['user_role']
          invited_by: string | null
          joined_at: string
        }
        Insert: {
          id?: string
          company_id: string
          user_id: string
          role?: Database['public']['Enums']['user_role']
          invited_by?: string | null
          joined_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          user_id?: string
          role?: Database['public']['Enums']['user_role']
          invited_by?: string | null
          joined_at?: string
        }
        Relationships: [
          { foreignKeyName: 'company_users_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] },
          { foreignKeyName: 'company_users_user_id_fkey'; columns: ['user_id']; referencedRelation: 'users'; referencedColumns: ['id'] }
        ]
      }
      stores: {
        Row: {
          id: string
          company_id: string
          name: string
          address: string | null
          postal_code: string | null
          city: string | null
          lat: number | null
          lng: number | null
          delivery_radius_km: number
          delivery_postal_codes: string[] | null
          is_active: boolean
          settings: Json
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id: string
          name: string
          address?: string | null
          postal_code?: string | null
          city?: string | null
          lat?: number | null
          lng?: number | null
          delivery_radius_km?: number
          delivery_postal_codes?: string[] | null
          is_active?: boolean
          settings?: Json
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          name?: string
          address?: string | null
          postal_code?: string | null
          city?: string | null
          lat?: number | null
          lng?: number | null
          delivery_radius_km?: number
          delivery_postal_codes?: string[] | null
          is_active?: boolean
          settings?: Json
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          { foreignKeyName: 'stores_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] }
        ]
      }
      uploads: {
        Row: {
          id: string
          company_id: string
          store_id: string | null
          uploaded_by: string
          filename: string
          storage_path: string
          file_size_bytes: number | null
          file_type: string | null
          row_count: number | null
          status: Database['public']['Enums']['upload_status']
          column_mapping: Json | null
          error_message: string | null
          processed_at: string | null
          period_start: string | null
          period_end: string | null
          created_at: string
        }
        Insert: {
          id?: string
          company_id: string
          store_id?: string | null
          uploaded_by: string
          filename: string
          storage_path: string
          file_size_bytes?: number | null
          file_type?: string | null
          row_count?: number | null
          status?: Database['public']['Enums']['upload_status']
          column_mapping?: Json | null
          error_message?: string | null
          processed_at?: string | null
          period_start?: string | null
          period_end?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          store_id?: string | null
          uploaded_by?: string
          filename?: string
          storage_path?: string
          file_size_bytes?: number | null
          file_type?: string | null
          row_count?: number | null
          status?: Database['public']['Enums']['upload_status']
          column_mapping?: Json | null
          error_message?: string | null
          processed_at?: string | null
          period_start?: string | null
          period_end?: string | null
          created_at?: string
        }
        Relationships: [
          { foreignKeyName: 'uploads_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] }
        ]
      }
      customers: {
        Row: {
          id: string
          company_id: string
          store_id: string | null
          upload_id: string | null
          phone_normalized: string | null
          phone_raw: string | null
          first_name: string | null
          last_name: string | null
          full_name: string | null
          street: string | null
          street_normalized: string | null
          house_number: string | null
          postal_code: string
          city: string | null
          lat: number | null
          lng: number | null
          total_orders: number
          total_revenue: number
          avg_order_value: number | null
          first_order_date: string | null
          last_order_date: string | null
          orders_last_30d: number | null
          orders_last_90d: number | null
          rfm_recency_days: number | null
          rfm_frequency: number | null
          rfm_monetary: number | null
          rfm_score: number | null
          rfm_segment: Database['public']['Enums']['rfm_segment'] | null
          is_vip: boolean
          is_active: boolean
          platform: string | null
          late_deliveries: number | null
          is_duplicate: boolean
          merged_into: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id: string
          store_id?: string | null
          upload_id?: string | null
          phone_normalized?: string | null
          phone_raw?: string | null
          first_name?: string | null
          last_name?: string | null
          full_name?: string | null
          street?: string | null
          street_normalized?: string | null
          house_number?: string | null
          postal_code: string
          city?: string | null
          lat?: number | null
          lng?: number | null
          total_orders?: number
          total_revenue?: number
          avg_order_value?: number | null
          first_order_date?: string | null
          last_order_date?: string | null
          orders_last_30d?: number | null
          orders_last_90d?: number | null
          rfm_recency_days?: number | null
          rfm_frequency?: number | null
          rfm_monetary?: number | null
          rfm_score?: number | null
          rfm_segment?: Database['public']['Enums']['rfm_segment'] | null
          is_vip?: boolean
          is_active?: boolean
          platform?: string | null
          late_deliveries?: number | null
          is_duplicate?: boolean
          merged_into?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          store_id?: string | null
          upload_id?: string | null
          phone_normalized?: string | null
          phone_raw?: string | null
          first_name?: string | null
          last_name?: string | null
          full_name?: string | null
          street?: string | null
          street_normalized?: string | null
          house_number?: string | null
          postal_code?: string
          city?: string | null
          lat?: number | null
          lng?: number | null
          total_orders?: number
          total_revenue?: number
          avg_order_value?: number | null
          first_order_date?: string | null
          last_order_date?: string | null
          orders_last_30d?: number | null
          orders_last_90d?: number | null
          rfm_recency_days?: number | null
          rfm_frequency?: number | null
          rfm_monetary?: number | null
          rfm_score?: number | null
          rfm_segment?: Database['public']['Enums']['rfm_segment'] | null
          is_vip?: boolean
          is_active?: boolean
          platform?: string | null
          late_deliveries?: number | null
          is_duplicate?: boolean
          merged_into?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          { foreignKeyName: 'customers_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] }
        ]
      }
      postal_codes: {
        Row: {
          id: string
          postal_code: string
          city: string
          state: string | null
          district: string | null
          municipality: string | null
          lat: number | null
          lng: number | null
          bbox_south: number | null
          bbox_north: number | null
          bbox_west: number | null
          bbox_east: number | null
          population: number | null
          households: number | null
          population_density: number | null
          area_km2: number | null
          avg_household_size: number | null
          data_source: Database['public']['Enums']['data_source']
          trust_level: Database['public']['Enums']['data_trust_level']
          population_source: Database['public']['Enums']['data_source'] | null
          population_year: number | null
          last_fetched_at: string | null
          needs_refresh: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          postal_code: string
          city: string
          state?: string | null
          district?: string | null
          municipality?: string | null
          lat?: number | null
          lng?: number | null
          bbox_south?: number | null
          bbox_north?: number | null
          bbox_west?: number | null
          bbox_east?: number | null
          population?: number | null
          households?: number | null
          population_density?: number | null
          area_km2?: number | null
          avg_household_size?: number | null
          data_source?: Database['public']['Enums']['data_source']
          trust_level?: Database['public']['Enums']['data_trust_level']
          population_source?: Database['public']['Enums']['data_source'] | null
          population_year?: number | null
          last_fetched_at?: string | null
          needs_refresh?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          postal_code?: string
          city?: string
          state?: string | null
          district?: string | null
          municipality?: string | null
          lat?: number | null
          lng?: number | null
          bbox_south?: number | null
          bbox_north?: number | null
          bbox_west?: number | null
          bbox_east?: number | null
          population?: number | null
          households?: number | null
          population_density?: number | null
          area_km2?: number | null
          avg_household_size?: number | null
          data_source?: Database['public']['Enums']['data_source']
          trust_level?: Database['public']['Enums']['data_trust_level']
          population_source?: Database['public']['Enums']['data_source'] | null
          population_year?: number | null
          last_fetched_at?: string | null
          needs_refresh?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      streets: {
        Row: {
          id: string
          postal_code: string
          name: string
          name_normalized: string
          osm_id: number | null
          street_type: string | null
          lat_center: number | null
          lng_center: number | null
          data_source: Database['public']['Enums']['data_source']
          last_fetched_at: string
          created_at: string
        }
        Insert: {
          id?: string
          postal_code: string
          name: string
          name_normalized: string
          osm_id?: number | null
          street_type?: string | null
          lat_center?: number | null
          lng_center?: number | null
          data_source?: Database['public']['Enums']['data_source']
          last_fetched_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          postal_code?: string
          name?: string
          name_normalized?: string
          osm_id?: number | null
          street_type?: string | null
          lat_center?: number | null
          lng_center?: number | null
          data_source?: Database['public']['Enums']['data_source']
          last_fetched_at?: string
          created_at?: string
        }
        Relationships: []
      }
      poi_businesses: {
        Row: {
          id: string
          postal_code: string
          name: string
          category: Database['public']['Enums']['poi_category']
          subcategory: string | null
          address: string | null
          street: string | null
          house_number: string | null
          city: string | null
          lat: number
          lng: number
          phone: string | null
          website: string | null
          rating: number | null
          review_count: number | null
          price_level: number | null
          opening_hours: Json | null
          is_chain: boolean
          chain_name: string | null
          is_competitor: boolean
          delivery_platforms: string[] | null
          osm_id: number | null
          google_place_id: string | null
          data_source: Database['public']['Enums']['data_source']
          last_fetched_at: string
          created_at: string
        }
        Insert: {
          id?: string
          postal_code: string
          name: string
          category: Database['public']['Enums']['poi_category']
          subcategory?: string | null
          address?: string | null
          street?: string | null
          house_number?: string | null
          city?: string | null
          lat: number
          lng: number
          phone?: string | null
          website?: string | null
          rating?: number | null
          review_count?: number | null
          price_level?: number | null
          opening_hours?: Json | null
          is_chain?: boolean
          chain_name?: string | null
          is_competitor?: boolean
          delivery_platforms?: string[] | null
          osm_id?: number | null
          google_place_id?: string | null
          data_source?: Database['public']['Enums']['data_source']
          last_fetched_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          postal_code?: string
          name?: string
          category?: Database['public']['Enums']['poi_category']
          subcategory?: string | null
          address?: string | null
          street?: string | null
          house_number?: string | null
          city?: string | null
          lat?: number
          lng?: number
          phone?: string | null
          website?: string | null
          rating?: number | null
          review_count?: number | null
          price_level?: number | null
          opening_hours?: Json | null
          is_chain?: boolean
          chain_name?: string | null
          is_competitor?: boolean
          delivery_platforms?: string[] | null
          osm_id?: number | null
          google_place_id?: string | null
          data_source?: Database['public']['Enums']['data_source']
          last_fetched_at?: string
          created_at?: string
        }
        Relationships: []
      }
      analytics: {
        Row: {
          id: string
          company_id: string
          store_id: string | null
          upload_id: string | null
          postal_code: string | null
          period_start: string | null
          period_end: string | null
          customer_count: number | null
          order_count: number | null
          revenue: number | null
          avg_order_value: number | null
          orders_per_customer: number | null
          population: number | null
          market_penetration_pct: number | null
          not_reached_residents: number | null
          streets_total: number | null
          streets_with_orders: number | null
          streets_without_orders: number | null
          streets_coverage_pct: number | null
          one_time_buyers: number | null
          repeat_customers: number | null
          vip_customers: number | null
          lost_customers: number | null
          new_customers: number | null
          reactivated_customers: number | null
          late_delivery_pct: number | null
          vip_usage_pct: number | null
          potential_scenarios: Json | null
          top_recommendations: Json | null
          computed_at: string
          created_at: string
        }
        Insert: {
          id?: string
          company_id: string
          store_id?: string | null
          upload_id?: string | null
          postal_code?: string | null
          period_start?: string | null
          period_end?: string | null
          customer_count?: number | null
          order_count?: number | null
          revenue?: number | null
          avg_order_value?: number | null
          orders_per_customer?: number | null
          population?: number | null
          market_penetration_pct?: number | null
          not_reached_residents?: number | null
          streets_total?: number | null
          streets_with_orders?: number | null
          streets_without_orders?: number | null
          streets_coverage_pct?: number | null
          one_time_buyers?: number | null
          repeat_customers?: number | null
          vip_customers?: number | null
          lost_customers?: number | null
          new_customers?: number | null
          reactivated_customers?: number | null
          late_delivery_pct?: number | null
          vip_usage_pct?: number | null
          potential_scenarios?: Json | null
          top_recommendations?: Json | null
          computed_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          store_id?: string | null
          upload_id?: string | null
          postal_code?: string | null
          period_start?: string | null
          period_end?: string | null
          customer_count?: number | null
          order_count?: number | null
          revenue?: number | null
          avg_order_value?: number | null
          orders_per_customer?: number | null
          population?: number | null
          market_penetration_pct?: number | null
          not_reached_residents?: number | null
          streets_total?: number | null
          streets_with_orders?: number | null
          streets_coverage_pct?: number | null
          one_time_buyers?: number | null
          repeat_customers?: number | null
          vip_customers?: number | null
          lost_customers?: number | null
          new_customers?: number | null
          reactivated_customers?: number | null
          late_delivery_pct?: number | null
          vip_usage_pct?: number | null
          potential_scenarios?: Json | null
          top_recommendations?: Json | null
          computed_at?: string
          created_at?: string
        }
        Relationships: [
          { foreignKeyName: 'analytics_company_id_fkey'; columns: ['company_id']; referencedRelation: 'companies'; referencedColumns: ['id'] }
        ]
      }
      street_analytics: {
        Row: {
          id: string
          analytics_id: string
          company_id: string
          postal_code: string
          street_name: string
          street_name_normalized: string
          customer_count: number
          order_count: number
          revenue: number
          avg_order_value: number | null
          orders_per_customer: number | null
          street_class: Database['public']['Enums']['street_class'] | null
          is_in_official_list: boolean
          trend_vs_prev_period: number | null
          created_at: string
        }
        Insert: {
          id?: string
          analytics_id: string
          company_id: string
          postal_code: string
          street_name: string
          street_name_normalized: string
          customer_count?: number
          order_count?: number
          revenue?: number
          avg_order_value?: number | null
          orders_per_customer?: number | null
          street_class?: Database['public']['Enums']['street_class'] | null
          is_in_official_list?: boolean
          trend_vs_prev_period?: number | null
          created_at?: string
        }
        Update: {
          id?: string
          analytics_id?: string
          company_id?: string
          postal_code?: string
          street_name?: string
          street_name_normalized?: string
          customer_count?: number
          order_count?: number
          revenue?: number
          avg_order_value?: number | null
          orders_per_customer?: number | null
          street_class?: Database['public']['Enums']['street_class'] | null
          is_in_official_list?: boolean
          trend_vs_prev_period?: number | null
          created_at?: string
        }
        Relationships: []
      }
      alerts: {
        Row: {
          id: string
          company_id: string
          store_id: string | null
          severity: Database['public']['Enums']['alert_severity']
          category: string
          title: string
          message: string
          metric_value: number | null
          threshold_value: number | null
          change_pct: number | null
          is_resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          company_id: string
          store_id?: string | null
          severity?: Database['public']['Enums']['alert_severity']
          category: string
          title: string
          message: string
          metric_value?: number | null
          threshold_value?: number | null
          change_pct?: number | null
          is_resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          store_id?: string | null
          severity?: Database['public']['Enums']['alert_severity']
          category?: string
          title?: string
          message?: string
          metric_value?: number | null
          threshold_value?: number | null
          change_pct?: number | null
          is_resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          created_at?: string
        }
        Relationships: []
      }
      marketing_actions: {
        Row: {
          id: string
          company_id: string
          store_id: string | null
          analytics_id: string | null
          action_type: Database['public']['Enums']['action_type']
          title: string
          description: string | null
          target_postal_codes: string[] | null
          target_streets: string[] | null
          target_segments: Database['public']['Enums']['rfm_segment'][] | null
          estimated_cost: number | null
          estimated_potential: number | null
          estimated_roi: number | null
          estimated_new_customers: number | null
          priority: number
          status: string
          scheduled_at: string | null
          completed_at: string | null
          actual_cost: number | null
          actual_revenue: number | null
          actual_roi: number | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          company_id: string
          store_id?: string | null
          analytics_id?: string | null
          action_type: Database['public']['Enums']['action_type']
          title: string
          description?: string | null
          target_postal_codes?: string[] | null
          target_streets?: string[] | null
          target_segments?: Database['public']['Enums']['rfm_segment'][] | null
          estimated_cost?: number | null
          estimated_potential?: number | null
          estimated_roi?: number | null
          estimated_new_customers?: number | null
          priority?: number
          status?: string
          scheduled_at?: string | null
          completed_at?: string | null
          actual_cost?: number | null
          actual_revenue?: number | null
          actual_roi?: number | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          company_id?: string
          store_id?: string | null
          analytics_id?: string | null
          action_type?: Database['public']['Enums']['action_type']
          title?: string
          description?: string | null
          target_postal_codes?: string[] | null
          target_streets?: string[] | null
          target_segments?: Database['public']['Enums']['rfm_segment'][] | null
          estimated_cost?: number | null
          estimated_potential?: number | null
          estimated_roi?: number | null
          estimated_new_customers?: number | null
          priority?: number
          status?: string
          scheduled_at?: string | null
          completed_at?: string | null
          actual_cost?: number | null
          actual_revenue?: number | null
          actual_roi?: number | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      user_role: 'owner' | 'admin' | 'manager' | 'viewer'
      upload_status: 'pending' | 'processing' | 'completed' | 'failed'
      data_source: 'openplz' | 'osm' | 'census' | 'google_places' | 'opendata_city' | 'manual' | 'estimated'
      data_trust_level: 'official' | 'public' | 'estimated' | 'manual'
      street_class: 'A' | 'B' | 'C' | 'D' | 'E'
      alert_severity: 'critical' | 'warning' | 'info'
      action_type: 'flyer' | 'sms' | 'app_campaign' | 'b2b_visit' | 'coupon' | 'reactivation' | 'loyalty'
      rfm_segment: 'vip' | 'loyal' | 'potential' | 'at_risk' | 'lost' | 'new'
      poi_category: 'restaurant' | 'competitor' | 'hotel' | 'school' | 'hospital' | 'authority' | 'fitness' | 'office' | 'commercial' | 'supermarket' | 'other'
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
