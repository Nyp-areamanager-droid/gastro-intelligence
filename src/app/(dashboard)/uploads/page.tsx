'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Upload, FileSpreadsheet, CheckCircle, AlertCircle, Loader } from 'lucide-react'

export default function UploadsPage() {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  function handleFile(f: File) {
    if (!f.name.match(/\.(xlsx|xls|csv)$/i)) {
      setMessage('Nur Excel (.xlsx, .xls) oder CSV Dateien erlaubt.')
      setStatus('error')
      return
    }
    setFile(f)
    setStatus('idle')
    setMessage('')
  }

  async function handleUpload() {
    if (!file) return
    setStatus('uploading')
    setMessage('Datei wird analysiert — das kann bis zu 30 Sekunden dauern...')

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Nicht eingeloggt')

      const { data: membership } = await supabase
        .from('company_users').select('company_id').eq('user_id', user.id).single()
      if (!membership) throw new Error('Kein Unternehmen gefunden')

      const formData = new FormData()
      formData.append('file', file)
      formData.append('company_id', membership.company_id)
      formData.append('user_id', user.id)

      const res = await fetch('/api/upload', { method: 'POST', body: formData })
      const json = await res.json()

      if (!res.ok) throw new Error(json.error || 'Upload fehlgeschlagen')

      setStatus('success')
      setMessage(`✅ Analyse abgeschlossen! ${json.customers_imported || ''} Kunden importiert. Dashboard wird aktualisiert.`)
      setFile(null)
    } catch (err) {
      setStatus('error')
      setMessage(String(err))
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Daten hochladen</h1>
        <p className="text-[#8a9bb5] text-sm mt-1">Excel oder CSV mit Bestelldaten importieren</p>
      </div>

      {/* Drop Zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
          dragOver ? 'border-red-500 bg-red-500/5' : 'border-[#2a3d5a] hover:border-[#4a5a70]'
        }`}>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
        />
        <FileSpreadsheet className="mx-auto mb-4 text-[#4a5a70]" size={48} />
        {file ? (
          <div>
            <p className="font-semibold text-white">{file.name}</p>
            <p className="text-[#8a9bb5] text-sm mt-1">{(file.size / 1024).toFixed(0)} KB</p>
          </div>
        ) : (
          <div>
            <p className="text-white font-medium">Datei hier ablegen oder klicken</p>
            <p className="text-[#8a9bb5] text-sm mt-1">Excel (.xlsx, .xls) oder CSV</p>
          </div>
        )}
      </div>

      {/* Upload Button */}
      {file && status !== 'success' && (
        <button
          onClick={handleUpload}
          disabled={status === 'uploading'}
          className="mt-4 w-full py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
          {status === 'uploading' ? <Loader size={18} className="animate-spin" /> : <Upload size={18} />}
          {status === 'uploading' ? 'Wird hochgeladen...' : 'Jetzt hochladen'}
        </button>
      )}

      {/* Status */}
      {message && (
        <div className={`mt-4 p-4 rounded-xl flex items-start gap-3 ${
          status === 'success' ? 'bg-green-500/10 border border-green-500/25 text-green-400'
          : status === 'error' ? 'bg-red-500/10 border border-red-500/25 text-red-400'
          : 'bg-blue-500/10 border border-blue-500/25 text-blue-400'
        }`}>
          {status === 'success' ? <CheckCircle size={18} className="flex-shrink-0 mt-0.5" />
          : status === 'error' ? <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
          : <Loader size={18} className="animate-spin flex-shrink-0 mt-0.5" />}
          <p className="text-sm">{message}</p>
        </div>
      )}

      {/* Hinweis */}
      <div className="mt-6 p-4 bg-[#1a2233] rounded-xl border border-[#2a3d5a]">
        <p className="text-xs text-[#8a9bb5] font-semibold uppercase tracking-wider mb-2">Erwartete Spalten</p>
        <p className="text-xs text-[#4a5a70]">
          Telefon, Vorname, Nachname, Straße, PLZ, Stadt, Bestellungen, Umsatz, Letztes Bestelldatum, Plattform
        </p>
      </div>
    </div>
  )
}
