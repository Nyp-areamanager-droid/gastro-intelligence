#!/usr/bin/env bash
# =============================================================================
# Deutschland-Referenzdaten aktualisieren (empfohlen: vierteljährlich)
#
#   scripts/geodaten/aktualisieren.sh <arbeitsordner>            nur aufbereiten + prüfen
#   DATABASE_URL=postgres://… scripts/geodaten/aktualisieren.sh <arbeitsordner> --laden
#
# Ablauf:
#   1. Quellen holen bzw. aktualisieren
#      - Straßen: git-Repository openpotato/openplzapi.data (ODbL)
#      - PLZ-Flächen: Release von yetzt/postleitzahlen (ODbL)
#      - Zensus 2022 (ändert sich nicht; nur beim ersten Lauf): Parquet aus
#        JsLth/z22data, alternativ die CSV-Dateien direkt von zensus2022.de
#   2. Aufbereiten (build-deutschland.ts) → strassen.csv, orte.csv, plz.csv, manifest.json
#   3. Prüfen (pruefung-deutschland.ts): bricht ab, wenn irgendwo eine falsche
#      PLZ vergeben würde oder Kennzahlen stark vom letzten Stand abweichen
#   4. Nur mit --laden: in die Datenbank aus DATABASE_URL laden (eine
#      Transaktion; das Produktionsprojekt verweigert laden.ts ohne Freigabe)
#
# Voraussetzungen: git, curl, node/npx, python3 mit duckdb (pip install duckdb)
# =============================================================================
set -euo pipefail
WORK="${1:?Arbeitsordner angeben}"; shift || true
LADEN=0; [[ "${1:-}" == "--laden" ]] && LADEN=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$WORK/quellen" "$WORK/arbeit"
cd "$WORK/quellen"

echo "== 1. Quellen"
if [[ -d openplzapi.data/.git ]]; then git -C openplzapi.data pull -q --ff-only; else git clone -q --depth 1 https://github.com/openpotato/openplzapi.data openplzapi.data; fi
REL="${PLZ_RELEASE:-latest}"
URL="https://github.com/yetzt/postleitzahlen/releases/${REL/#latest/latest\/download}"; [[ "$REL" != latest ]] && URL="https://github.com/yetzt/postleitzahlen/releases/download/$REL"
curl -fsSL -o postleitzahlen.geojson.br "$URL/postleitzahlen.geojson.br"
node -e 'const z=require("zlib"),f=require("fs");const g=JSON.parse(z.brotliDecompressSync(f.readFileSync(process.argv[1])));for(const x of g.features)x.properties={postal_code:x.properties.postcode,osm_relation:x.properties.rel};f.writeFileSync(process.argv[2],JSON.stringify(g))' postleitzahlen.geojson.br "$WORK/arbeit/plz-flaechen.geojson"
if [[ ! -f "$WORK/arbeit/population_0.csv" ]]; then
  if [[ ! -d z22data/.git ]]; then GIT_LFS_SKIP_SMUDGE=1 git clone -q --depth 1 --filter=blob:none --no-checkout https://github.com/JsLth/z22data z22data; fi
  git -C z22data -c gc.auto=0 checkout HEAD -- z22_data_100m/population_0.parquet z22_data_100m/households_0.parquet
  python3 - "$WORK" <<'PY'
import duckdb, sys
w = sys.argv[1]
for f, col in [('population_0', 'Einwohner'), ('households_0', 'Insgesamt')]:
    duckdb.sql(f"copy (select x as x_mp_100m, y as y_mp_100m, value as {col} from '{w}/quellen/z22data/z22_data_100m/{f}.parquet') to '{w}/arbeit/{f}.csv' (header, delimiter ';')")
PY
fi
cat > "$WORK/arbeit/quellen.json" <<EOF
{ "strassen": { "commit": "$(git -C openplzapi.data rev-parse HEAD)", "commit_datum": "$(git -C openplzapi.data log -1 --format=%cs)" },
  "plz_flaechen": { "release": "$REL", "datei": "postleitzahlen.geojson.br" },
  "zensus": { "commit": "$( [[ -d z22data/.git ]] && git -C z22data rev-parse HEAD || echo unverändert)" } }
EOF

echo "== 2. Aufbereiten"
cd "$ROOT"
OUT="$WORK/ausgabe-$(date +%Y%m%d)"
NODE_OPTIONS=--max-old-space-size=8000 npx tsx scripts/geodaten/build-deutschland.ts \
  --strassen "$WORK/quellen/openplzapi.data/src/de/osm/streets.updated.csv" --plz "$WORK/arbeit/plz-flaechen.geojson" \
  --einwohner "$WORK/arbeit/population_0.csv" --haushalte "$WORK/arbeit/households_0.csv" \
  --quellen "$WORK/arbeit/quellen.json" --out "$OUT"

echo "== 3. Prüfen"
NODE_OPTIONS=--max-old-space-size=8000 npx tsx scripts/geodaten/pruefung-deutschland.ts --dir "$OUT" --out "$OUT/pruefung.json" --n 400
node - "$OUT" "${VORHER:-}" <<'JS'
const fs = require('fs'); const [out, prev] = process.argv.slice(2)
const p = JSON.parse(fs.readFileSync(out + '/pruefung.json')); const m = JSON.parse(fs.readFileSync(out + '/manifest.json'))
let wrong = 0; for (const r of Object.values(p.ergebnisse)) for (const c of Object.values(r)) wrong += c.falsche_plz
if (wrong) { console.error(`Abbruch: ${wrong} falsche PLZ-Zuordnungen in der Prüfung.`); process.exit(1) }
if (m.zaehlung.plz_mit_strassen < 8000 || m.zaehlung.strassen_eintraege < 1_000_000) { console.error('Abbruch: Verzeichnis unerwartet klein.'); process.exit(1) }
if (prev && fs.existsSync(prev + '/manifest.json')) {
  const v = JSON.parse(fs.readFileSync(prev + '/manifest.json')).zaehlung
  const d = Math.abs(m.zaehlung.strassen_eintraege - v.strassen_eintraege) / v.strassen_eintraege
  if (d > 0.05) { console.error(`Abbruch: Straßenzahl weicht um ${(d * 100).toFixed(1)} % vom letzten Stand ab – bitte von Hand prüfen.`); process.exit(1) }
}
console.log('Prüfung bestanden:', JSON.stringify(m.zaehlung.strassen_eintraege), 'Straßen,', m.zaehlung.plz_gesamt, 'PLZ')
JS

if [[ $LADEN == 1 ]]; then
  echo "== 4. Laden"
  npx tsx scripts/geodaten/laden.ts --dir "$OUT"
else
  echo "Fertig (nicht geladen). Laden: DATABASE_URL=… npx tsx scripts/geodaten/laden.ts --dir $OUT"
fi
