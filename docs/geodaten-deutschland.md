# Geodaten für ganz Deutschland

Stand: 14.11.2026. Gilt für Migration 009 und die Skripte in `scripts/geodaten/`.

## Was die Plattform damit kann

- Jede importierte Adresse wird gegen ein Straßenverzeichnis für ganz Deutschland geprüft.
- Eine fehlende PLZ wird ergänzt, aber nur, wenn Straße und Ort genau eine PLZ ergeben.
- Eine angegebene PLZ wird nie verändert. Passt die Straße nicht zur PLZ, steht das im Fehlerbericht.
- Für jede deutsche PLZ gibt es Einwohner und Haushalte aus dem Zensus 2022, Mittelpunkt, Ausdehnung und Fläche.
  Daraus berechnet die App „Bestellungen je 1.000 Einwohner“ und die Nachbargebiete ohne Bestellungen.
- Die Straßenauswertung braucht keinen Live-Abruf je PLZ mehr. Fehlt eine PLZ im Verzeichnis, fragt die App wie bisher openplzapi.org.

## Quellen, Lizenzen, Stand

| Inhalt | Quelle | Lizenz | Stand |
|---|---|---|---|
| Straßen je PLZ, Orte, Stadtbezirke, Gemeindeschlüssel | OpenPLZ API Data, `streets.updated.csv` (aus OpenStreetMap) | ODbL 1.0, © OpenStreetMap-Mitwirkende | Commit c26389b vom 22.11.2025 |
| PLZ-Flächen | yetzt/postleitzahlen, Release 2026.02 (OSM `boundary=postal_code`) | ODbL 1.0, © OpenStreetMap-Mitwirkende | 20.02.2026 |
| Einwohner, Haushalte | Zensus 2022, Gitterdaten 100 m (Destatis), als Parquet aus JsLth/z22data | Datenlizenz Deutschland – Namensnennung 2.0, © Destatis | Stichtag 15.05.2022 |

Prüfsummen aller Eingangsdateien stehen in `manifest.json` jeder Aufbereitung.

Pflicht zur Namensnennung: Die App nennt die Quellen in der PLZ-Ansicht, in der Adressprüfung und an der Karte.
Für die ODbL gilt außerdem: Wird die Datenbank selbst weitergegeben (nicht nur Auswertungen daraus), muss sie unter derselben Lizenz stehen.
Ob das auf Exporte für Kunden zutrifft, sollte extern geprüft werden.

## Tatsächliche Abdeckung (gemessen)

| Kennzahl | Wert |
|---|---|
| Straßen-PLZ-Kombinationen in der Quelle | 1.201.689 |
| Eindeutige Straßen je PLZ (nach Zusammenfassung gleicher Namen) | 1.164.527 |
| Straßen (Name + Gemeinde) | 1.167.237 |
| PLZ mit Straßenliste | 8.159 |
| PLZ mit Fläche | 8.175 |
| PLZ gesamt (Vereinigung) | 8.176 |
| Gemeindeschlüssel | 10.708 |
| Orte | 10.199 |
| Einträge Ort/Stadtbezirk/Stadtteil je PLZ | 28.453 |
| PLZ mit Einwohnerzahl | 8.175 |
| davon unter 1.000 Einwohner (nur eingeschränkt belastbar) | 361 |
| PLZ mit belastbarer Haushaltszahl | 7.296 |
| PLZ, bei denen die Haushaltszahl nicht übernommen wurde | 879 |
| Einwohner im Gitter / davon PLZ zugeordnet | 82.570.995 / 82.568.721 |
| Haushalte im Gitter / davon PLZ zugeordnet | 39.615.530 / 39.614.493 |

Weitere Angaben zur Abdeckung:

- **PLZ ohne Straßen:** 17 PLZ haben eine Fläche, aber keine Straßen. Meist sind es Großkunden- oder Postfach-PLZ, zum Beispiel 60306 in Frankfurt und 33333 in Gütersloh.
- **PLZ ohne Fläche:** Eine PLZ (94158) hat Straßen, aber keine Fläche.
- **Gemeinden:** Laut OpenPLZ fehlen in der Straßenquelle 119 Gemeindeschlüssel der amtlichen Gemeindeliste. Das sind vor allem Gebiete ohne Bebauung.
- **Hausnummern:** Sie sind nicht enthalten. Eine Straße, die durch mehrere PLZ läuft, lässt sich ohne PLZ-Angabe deshalb nicht auf die Hausnummer genau zuordnen.
- **Mehrdeutigkeit:** 98,6 % aller Straßennamen liegen innerhalb ihres Orts in genau einer PLZ (1.948.592 von 1.975.531). Die übrigen 1,4 % sind ohne PLZ mehrdeutig, etwa die Venloer Straße in Köln mit 5 PLZ oder die Invalidenstraße in Berlin mit 2.
- **Vollständigkeit:** Ob OpenStreetMap jede Straße Deutschlands kennt, lässt sich hier nicht gegen eine amtliche Liste prüfen. Die amtliche Straßendatei der Deutschen Post ist kostenpflichtig. Für Deutschland gilt OpenStreetMap als sehr gut gepflegt.

## Einwohner und Haushalte: Methode und Genauigkeit

- **Zuordnung:** Jede bewohnte 100-m-Zelle des Zensus 2022 zählt zu der PLZ, in deren Fläche ihr Mittelpunkt liegt (`population_method = zensus2022_gitter100m_plz_osm`). Es wird nichts geschätzt oder hochgerechnet.
- **Datenschutz im Zensus:** Kleine Werte werden geheim gehalten oder leicht verändert. Bundesweit weicht die Summe der 100-m-Zellen deshalb um 0,16 % von der Summe des 1-km-Gitters ab (82.570.995 gegenüber 82.706.456). Bei großen PLZ spielt das keine Rolle, bei sehr kleinen schon.
- **Kleine Einwohnerzahlen:** Unter 1.000 Einwohnern wird die Zahl angezeigt, aber mit Stern gekennzeichnet, und sie fließt in keine Empfehlung ein.
- **Haushalte:** In dünn besiedelten Gebieten fehlen Haushaltszellen oft ganz. Erkennbar ist das an einer unplausiblen Haushaltsgröße (Hamburg 20095 käme auf 7,3 Personen je Haushalt).
  - Haushaltszahlen werden deshalb nur übernommen, wenn die Haushaltsgröße zwischen 1,3 und 3,0 liegt und mindestens 70 % der bewohnten Zellen einen Haushaltswert haben.
  - Sonst bleibt das Feld leer: „—“ statt einer falschen Zahl.
- **Quelle des Zensus:** Die Zensus-Werte stammen aus einer Aufbereitung auf GitHub (JsLth/z22data), weil zensus2022.de von der Arbeitsumgebung aus gesperrt war. Die Werte wurden stichprobenartig auf Plausibilität geprüft (Summen, Städte, ländliche PLZ). Vor der Produktion sollte das Gitter einmal direkt von zensus2022.de geladen werden.
  - Das Skript `scripts/zensus-plz-import.ts` bzw. `build-deutschland.ts` nimmt die amtlichen CSV-Dateien unverändert an: `x_mp_100m;y_mp_100m;Einwohner`.
  - Danach `manifest.json` vergleichen.

## Prüfung der Zuordnung (gemessen, `pruefung.json`)

Je Region 400 künstliche Testadressen aus dem Verzeichnis selbst, verfälscht wie echte Exporte. Seed 42, wiederholbar.

| Region | PLZ stimmt | andere Schreibweise | Tippfehler korrigiert | ohne PLZ richtig | ohne PLZ mit Region | falsche PLZ erkannt |
|---|---|---|---|---|---|---|
| Köln | 400/400 | 400/400 | 329/339 | 400/400 | 126/126 | 400/400 |
| Berlin | 400/400 | 400/400 | 332/335 | 400/400 | 163/163 | 397/400 |
| Hamburg | 400/400 | 400/400 | 316/318 | 400/400 | 95/95 | 396/400 |
| München | 400/400 | 400/400 | 357/359 | 399/400 | 61/61 | 400/400 |
| Dresden | 400/400 | 400/400 | 321/329 | 400/400 | 109/109 | 400/400 |
| Leipzig | 400/400 | 400/400 | 323/327 | 400/400 | 78/78 | 399/400 |
| Ländliche Gemeinden | 400/400 | 400/400 | 253/264 | 395/400 | 7/7 | 55/55 |

So sind die Spalten zu lesen:

- **Falsch vergebene PLZ:** In keinem einzigen Fall wurde eine falsche PLZ vergeben.
- **„ohne PLZ richtig“:** Richtig heißt: Die PLZ wurde ergänzt, wenn sie eindeutig war, und sonst „mehrdeutig“ gemeldet.
  - Die 5 ländlichen Abweichungen sind Ortsnamen, die es in Deutschland mehrfach gibt („Neuenkirchen“, „Neuhof“).
  - Dort bleibt es bei „mehrdeutig“, bis die übrigen Zeilen der Datei eine Region festlegen. Diesen Fall misst die Spalte „mit Region“.
- **„falsche PLZ erkannt“:** Gezählt ist, ob die Zeile als „PLZ prüfen“ gemeldet wurde und die richtige PLZ unter den genannten steht. Die wenigen Abweichungen sind Straßennamen mit mehr als 10 PLZ im Ort (zum Beispiel „Fliederweg“ in Berlin): Die Meldung kommt, aber die Liste ist auf 10 PLZ gekürzt.
- **„Tippfehler korrigiert“:** Nicht korrigiert werden Namen, deren Vergleichsschlüssel kürzer als 7 Zeichen ist (zum Beispiel „…gasse“-Namen). Sie erscheinen als „unbekannt“, nie als falsche Straße.
- **Wichtige Einschränkung:** Diese Prüfung misst die Zuordnungslogik und die Mehrdeutigkeit der echten deutschen Straßennamen. Sie misst nicht, wie gut echte Kassenexporte zum Verzeichnis passen. Das zeigt sich erst im Test mit echten Exporten.

Geschwindigkeit: rund 6 Mikrosekunden je Adresse, 10.000 Zeilen also in unter 0,1 Sekunden.

## Datenbank und Speicher

- **Tabellen:** Migration 009 legt `street_directory` an (eine Zeile je PLZ mit allen Straßennamen als Liste) und `plz_localities` (Orte und Stadtteile je PLZ).
  - Lesen dürfen nur angemeldete Nutzer, schreiben niemand über die App.
  - Der Service-Key-Client der App kennt diese Tabellen nicht.
- **Neue Spalten:** `postal_codes.ags`, `population_quality`, `households_quality`, `reference_version`, `customers.geo_status` und `uploads.geo_summary`.
- **Speicher, gemessen in PostgreSQL 17:**
  - Straßenverzeichnis 15 MB, Ortstabelle 4 MB, PLZ-Stammdaten 3–9 MB.
  - Eine erste Fassung mit einer Zeile je Straße hätte 323 MB gebraucht. Das ist zu viel für den kostenlosen Supabase-Tarif mit 500 MB.
- **Laden:** `scripts/geodaten/laden.ts`, eine Transaktion, rund 2 Sekunden.
  - Prüft die Dateien gegen `manifest.json` und bricht bei Abweichung ab. Der alte Stand bleibt dann erhalten.
  - Verweigert den Lauf gegen das Produktionsprojekt ohne `GEODATEN_PRODUKTION_FREIGABE=ja`.

## Aktualisierung

`scripts/geodaten/aktualisieren.sh <ordner>` holt die Quellen, bereitet auf und prüft. Bei falsch vergebenen PLZ oder mehr als 5 % Abweichung zur Vorversion bricht es ab. Mit `--laden` lädt es anschließend. Vollständiger Lauf: 72 Sekunden, die Ergebnisse sind byte-gleich reproduzierbar.

Empfehlung: vierteljährlich laufen lassen. Der Zensus ändert sich nicht, die nächste Zählung ist 2031.

## Bekannte Grenzen

- **Hausnummern:** Es gibt keine Hausnummern und keine Hausnummernbereiche. Zuordnung und Karte arbeiten auf Straßenebene.
- **Lage der Straßen:** Eine Straße zählt zu der PLZ, in der der Mittelpunkt ihres OSM-Abschnitts liegt. Lange Straßen bestehen aus vielen Abschnitten und erscheinen deshalb in allen betroffenen PLZ. Einzelne kurze Abschnitte an einer PLZ-Grenze können aber fehlen. Darum ändert die App eine angegebene PLZ nie, sondern meldet nur.
- **Gleichnamige Orte:** Ortsnamen, die es mehrfach gibt („Frankfurt“ ohne Zusatz, „Halle“), führen ohne PLZ zu keinem Ergebnis statt zu einem geratenen.
- **Alter der Straßenquelle:** Der Stand ist November 2025. Neubaustraßen nach diesem Datum fehlen bis zur nächsten Aktualisierung.
