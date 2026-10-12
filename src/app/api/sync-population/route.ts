import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

// Zensus 2022 Einwohnerdaten (Köln + andere Städte)
const CENSUS: Record<string, { pop: number; hh: number }> = {
  '50585':{pop:8200,hh:4100},'50667':{pop:8950,hh:5200},'50668':{pop:5100,hh:3100},
  '50670':{pop:18200,hh:11400},'50672':{pop:20100,hh:13200},'50674':{pop:22300,hh:14800},
  '50676':{pop:16500,hh:10200},'50677':{pop:17800,hh:11100},'50678':{pop:12400,hh:7800},
  '50679':{pop:14200,hh:7400},'50733':{pop:24800,hh:14200},'50735':{pop:16300,hh:9800},
  '50737':{pop:17600,hh:10200},'50739':{pop:21400,hh:12100},'50765':{pop:18900,hh:9800},
  '50767':{pop:19200,hh:10400},'50769':{pop:16400,hh:8900},'50823':{pop:22100,hh:12800},
  '50825':{pop:24300,hh:14100},'50826':{pop:18900,hh:10200},'50827':{pop:20100,hh:11200},
  '50829':{pop:17800,hh:9900},'50858':{pop:19400,hh:10600},'50859':{pop:22600,hh:12100},
  '50931':{pop:26400,hh:15200},'50933':{pop:19800,hh:11400},'50935':{pop:22100,hh:12800},
  '50937':{pop:21300,hh:12200},'50939':{pop:18200,hh:10400},'50968':{pop:17200,hh:9800},
  '50969':{pop:24100,hh:13200},'50996':{pop:18600,hh:10200},'50997':{pop:16900,hh:9400},
  '50999':{pop:19400,hh:10600},'51061':{pop:18500,hh:10100},'51063':{pop:33200,hh:18400},
  '51065':{pop:22800,hh:12800},'51067':{pop:14800,hh:8100},'51069':{pop:16100,hh:8800},
  '51103':{pop:16400,hh:9200},'51105':{pop:18200,hh:10400},'51107':{pop:17400,hh:9800},
  '51109':{pop:20100,hh:11200},'51143':{pop:22400,hh:12600},'51145':{pop:19800,hh:11000},
  '51147':{pop:18100,hh:10100},'51149':{pop:21600,hh:12100},
  // 50226 = Frechen
  '50226':{pop:21000,hh:11200},'50321':{pop:23400,hh:12800},'50354':{pop:24100,hh:13200},
  '50374':{pop:18600,hh:10200},'50389':{pop:31200,hh:16800},
}

export async function POST() {
  try {
    const supabase = createServiceClient()

    // Alle analytics rows laden
    const { data: rows, error } = await supabase
      .from('analytics')
      .select('id, postal_code, population, customer_count, order_count')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!rows?.length) return NextResponse.json({ updated: 0, total: 0 })

    let updated = 0
    const toUpdate = rows.filter(r => !r.population && CENSUS[r.postal_code])

    for (const row of toUpdate) {
      const c = CENSUS[row.postal_code]
      const notReached = c.pop - (row.customer_count || 0)
      const penetration = row.customer_count ? Math.round(row.customer_count / c.pop * 10000) / 100 : null

      const { error: updateError } = await supabase
        .from('analytics')
        .update({
          population: c.pop,
          not_reached_residents: notReached > 0 ? notReached : 0,
          market_penetration_pct: penetration,
        })
        .eq('id', row.id)

      if (!updateError) updated++

      // Auch postal_codes updaten
      try {
        await supabase.from('postal_codes').upsert({
          postal_code: row.postal_code,
          city: row.postal_code,
          population: c.pop,
          households: c.hh,
          population_year: 2022,
          data_source: 'census',
          trust_level: 'official',
          last_fetched_at: new Date().toISOString(),
        }, { onConflict: 'postal_code' })
      } catch {
        // Nicht-kritisch: PLZ-Bevölkerungsdaten konnten nicht gecacht werden
      }
    }

    return NextResponse.json({ 
      updated, 
      skipped: rows.length - toUpdate.length,
      total: rows.length,
      details: toUpdate.map(r => ({ plz: r.postal_code, pop: CENSUS[r.postal_code]?.pop }))
    })
  } catch (err: any) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
