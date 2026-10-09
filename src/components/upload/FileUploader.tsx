'use client'

import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface UploadResult {
  success: boolean
  summary?: {
    total_rows: number
    valid_rows: number
    duplicate_rows: number
    error_rows: number
    unique_plz: number
    period: { start: string | null; end: string | null }
  }
  kpis?: Record<string, number>
  alerts?: number
  recommendations?: number
  error?: string
}

export function FileUploader() {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<UploadResult | null>(null)
  const [progress, setProgress] = useState(0)
  const supabase = createClient()

  const onDrop = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return

    const allowed = ['.xlsx','.xls','.xlsb','.csv']
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
    if (!allowed.includes(ext)) {
      setResult({ success: false, error: `Nicht unterstütztes Format: ${ext}. Erlaubt: ${allowed.join(', ')}` })
      setStatus('error')
      return
    }

    setStatus('uploading')
    setProgress(10)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setStatus('error'); setResult({ success: false, error: 'Nicht angemeldet' }); return }

    const { data: membership } = await supabase
      .from('company_users').select('company_id').eq('user_id', user.id).single()
    if (!membership) { setStatus('error'); return }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('company_id', membership.company_id)
    formData.append('user_id', user.id)

    setProgress(30)
    setStatus('processing')

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData })
      setProgress(90)
      const data: UploadResult = await res.json()

      if (data.success) {
        setStatus('done')
        setResult(data)
        setProgress(100)
      } else {
        setStatus('error')
        setResult(data)
      }
    } catch (err) {
      setStatus('error')
      setResult({ success: false, error: String(err) })
    }
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls', '.xlsb'],
      'text/csv': ['.csv'],
    },
    maxFiles: 1,
    disabled: status === 'uploading' || status === 'processing',
  })

  return (
    <div className="max-w-2xl mx-auto">
      {/* Dropzone */}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all ${
          isDragActive ? 'border-brand-red bg-brand-red/5' :
          status === 'done' ? 'border-emerald-500/50 bg-emerald-500/5' :
          status === 'error' ? 'border-red-500/50 bg-red-500/5' :
          'border-[#2a3d5a] bg-[#111827] hover:border-brand-red/50 hover:bg-brand-red/5'
        }`}
      >
        <input {...getInputProps()} />

        {status === 'idle' && (
          <>
            <Upload className="w-12 h-12 text-[#4a5a70] mx-auto mb-4" />
            <div className="text-lg font-semibold mb-2">Excel oder CSV hochladen</div>
            <div className="text-[#8a9bb5] text-sm mb-4">Ziehen Sie Ihre Datei hierher oder klicken Sie</div>
            <div className="flex gap-2 justify-center">
              {['.xlsx', '.xls', '.xlsb', '.csv'].map(ext => (
                <span key={ext} className="badge badge-dim">{ext}</span>
              ))}
            </div>
          </>
        )}

        {(status === 'uploading' || status === 'processing') && (
          <>
            <Loader2 className="w-12 h-12 text-brand-gold mx-auto mb-4 animate-spin" />
            <div className="text-lg font-semibold mb-2">
              {status === 'uploading' ? 'Datei wird hochgeladen...' : 'Analyse läuft...'}
            </div>
            <div className="text-[#8a9bb5] text-sm mb-4">
              {status === 'processing' && 'Bereinigung · PLZ-Abgleich · Straßenverzeichnis · RFM · Empfehlungen'}
            </div>
            <div className="w-full bg-[#1a2233] rounded-full h-1.5 max-w-xs mx-auto">
              <div
                className="h-1.5 rounded-full bg-brand-red transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        )}

        {status === 'done' && (
          <>
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
            <div className="text-lg font-semibold mb-2 text-emerald-400">Analyse abgeschlossen!</div>
          </>
        )}

        {status === 'error' && (
          <>
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
            <div className="text-lg font-semibold mb-2 text-red-400">Fehler</div>
            <div className="text-[#8a9bb5] text-sm">{result?.error}</div>
          </>
        )}
      </div>

      {/* Ergebnis */}
      {status === 'done' && result?.summary && (
        <div className="mt-6 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryCard label="Gültige Datensätze" value={result.summary.valid_rows} color="text-emerald-400" />
            <SummaryCard label="Duplikate entfernt" value={result.summary.duplicate_rows} color="text-amber-400" />
            <SummaryCard label="PLZ-Gebiete" value={result.summary.unique_plz} color="text-blue-400" />
            <SummaryCard label="Empfehlungen" value={result.recommendations || 0} color="text-brand-red" />
          </div>

          {result.summary.period.start && (
            <div className="card text-sm text-[#8a9bb5]">
              <span className="font-semibold text-white">Zeitraum:</span>{' '}
              {result.summary.period.start} — {result.summary.period.end}
            </div>
          )}

          <button
            onClick={() => { setStatus('idle'); setResult(null); setProgress(0) }}
            className="btn-ghost w-full"
          >
            Weitere Datei hochladen
          </button>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card text-center">
      <div className={`text-2xl font-bold font-mono ${color} mb-1`}>{value.toLocaleString('de-DE')}</div>
      <div className="text-[10px] text-[#8a9bb5] uppercase tracking-wider">{label}</div>
    </div>
  )
}
