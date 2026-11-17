# Probelauf auf der Produktionskopie (Stand 17.11.2026)

Quelle: `produktion.backup` (pg_dump 17.12, Format custom, `--no-owner --no-acl`, Quelle Postgres 17.6). Nur lokal verwendet.

1. Leere lokale Datenbank `prodcopy` auf dem Test-PostgreSQL 17 anlegen, Rollen (anon, authenticated, service_role, supabase_* …) als NOLOGIN anlegen.
2. `pg_restore --no-owner -f restore.sql produktion.backup` (pg_restore ≥ 17 nötig), dann `psql -d prodcopy -f restore.sql`.
   Erwartete Fehler (harmlos): Erweiterungen `postgis` und `supabase_vault` fehlen lokal, daher auch `public.spatial_ref_sys` und `vault.secrets`.
   Keine App-Tabelle nutzt PostGIS.
3. `node supabase/pending/test/prodkopie-probelauf.cjs` – kopiert `prodcopy` nach `prodrun`, spielt 002–012 ein, prüft Daten und Rechte, spielt Rückfälle.
4. Nicht in der Sicherung (wegen `--no-acl`/pg_dump): Tabellenrechte, Auslöser auf `auth.users`, Storage-Dateien. Siehe `supabase/pending/check_rechte_produktion.sql` und Storage-Sicherung.
