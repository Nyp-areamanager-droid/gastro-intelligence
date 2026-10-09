# Gastro Intelligence Platform

Deutschlandweite SaaS-Plattform für Gastronomie, Lieferdienste und Franchisesysteme.

## Stack

| Schicht | Technologie |
|---|---|
| Frontend | Next.js 14 + TypeScript + TailwindCSS |
| Backend | Next.js API Routes |
| Datenbank | Supabase PostgreSQL |
| Auth | Supabase Auth |
| Storage | Supabase Storage |
| Deployment | Vercel |
| Karte | OpenStreetMap + Leaflet |
| Excel | SheetJS |
| Charts | Recharts |

## Schnellstart

### 1. Projekt klonen & installieren

```bash
git clone https://github.com/your-org/gastro-intelligence
cd gastro-intelligence
npm install
```

### 2. Supabase einrichten

1. Neues Projekt unter https://supabase.com anlegen
2. SQL-Migration ausführen: `supabase/migrations/001_initial_schema.sql`
3. Storage-Bucket `uploads` wird automatisch durch Migration angelegt

### 3. Umgebungsvariablen

```bash
cp .env.local.example .env.local
```

Dann ausfüllen:

```env
NEXT_PUBLIC_SUPABASE_URL=https://DEIN-PROJEKT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=dein-anon-key
SUPABASE_SERVICE_ROLE_KEY=dein-service-role-key
GOOGLE_PLACES_API_KEY=          # optional
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. Entwicklung starten

```bash
npm run dev
```

### 5. Auf Vercel deployen

```bash
vercel --prod
```

---

## Architektur

### Multi-Tenant

```
companies
  └── company_users (Rollen: owner | admin | manager | viewer)
  └── stores (Filialen)
  └── uploads (Excel-Imports)
  └── customers (bereinigt, mit RFM)
  └── analytics (PLZ-Analysen)
  └── marketing_actions (Empfehlungen)
  └── alerts (Frühwarnungen)
```

Jede Tabelle ist durch **Row Level Security (RLS)** mandantenfähig.  
Kein Mandant kann Daten eines anderen sehen.

### Datenquellen

| Quelle | Was | Kosten |
|---|---|---|
| OpenPLZ API | Straßenverzeichnis Deutschland | Kostenlos |
| OSM Overpass API | POIs, Wettbewerber, Firmen | Kostenlos |
| Zensus 2022 | Einwohnerdaten pro PLZ | Kostenlos (eingebettet) |
| Google Places | Ergänzende POIs | Optional, Pay-per-use |

### Data Provider Layer

```typescript
// Austauschbare Provider
openplzProvider    // Amtliches Straßenverzeichnis
osmProvider        // OpenStreetMap POIs
censusProvider     // Zensus 2022 Bevölkerungsdaten
googlePlacesProvider // Optional
```

---

## Funktionen

### Dateiimport
- CSV, XLSX, XLS, XLSB
- Automatische Spaltenerkennung
- Duplikat-Entfernung
- PLZ-Validierung
- Telefonnummer-Normalisierung
- Straßennamen-Bereinigung

### Analysen
- **PLZ-Analyse**: Marktdurchdringung, Einwohner, Potenzial
- **Straßen-Analyse**: Klassen A–E, unerreichte Straßen
- **Kunden-Analyse**: RFM-Segmentierung (VIP, Loyal, At Risk, Lost)
- **Wettbewerber**: Automatisch aus OSM
- **B2B-Analyse**: Firmen, Hotels, Schulen, Behörden
- **App-Migration**: Plattformkosten-Einsparungsszenarien

### Frühwarnungen
- Einmalkäufer-Rate > 70%
- Verspätungsrate > 15%
- VIP-Quote < 1%
- Umsatzrückgang > 10%

### Empfehlungsengine
- SMS-Reaktivierung (mit ROI-Berechnung)
- Flyer-Aktionen (schwächste PLZ)
- B2B-Akquise (hoher Ø Bon)
- App-Migration
- VIP-Programm

### Kartenansicht
- OpenStreetMap
- Straßen farbcodiert (Grün/Gelb/Rot/Grau)
- POI-Marker (Wettbewerber, Hotels, Schulen...)
- Legende

---

## API-Endpunkte

| Endpoint | Methode | Funktion |
|---|---|---|
| `/api/upload` | POST | Excel verarbeiten |
| `/api/analysis/plz` | GET | PLZ-Analyse |
| `/api/analysis/streets` | GET | Straßen-Analyse |
| `/api/providers/openplz` | GET | Straßen live laden |
| `/api/providers/osm` | GET | POIs laden |
| `/api/providers/census` | GET | Bevölkerungsdaten |

---

## Sicherheit

- **RLS**: Alle mandantenspezifischen Tabellen sind durch Row Level Security geschützt
- **Rollen**: owner > admin > manager > viewer
- **DSGVO**: Keine Weitergabe an Dritte, Daten bleiben in Supabase (EU-Region wählbar)
- **Storage**: Upload-Bucket ist privat (kein öffentlicher Zugriff)

---

## Bekannte Einschränkungen

- Einwohnerzahlen: Zensus 2022 deckt ~300 PLZ ab. Für unbekannte PLZ wird eine Schätzung ausgegeben mit deutlichem Hinweis.
- OSM-Daten: Qualität variiert je nach PLZ. In ländlichen Gebieten weniger vollständig.
- Google Places: Nur mit eigenem API-Key verfügbar (Kosten trägt der Mandant).

---

## Lizenz

Proprietary — alle Rechte vorbehalten.
