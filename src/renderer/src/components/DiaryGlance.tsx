import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import type { DiaryGlance as Glance } from '../../../shared/diary-glance'

export function DiaryGlance({ dir, onSettings }: { dir: string; onSettings: () => void }): JSX.Element | null {
  const [glance, setGlance] = useState<Glance | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    let generation = 0
    setGlance(null)
    const reload = async () => {
      const request = ++generation
      try {
        const value = await window.writeflex.diary.glance(dir)
        if (!disposed && request === generation) { setGlance(value); setError(null) }
      } catch (cause) { if (!disposed && request === generation) setError(cause instanceof Error ? cause.message : 'Could not read the Diary.') }
    }
    void reload()
    const timer = setInterval(() => { void reload() }, 5_000)
    const off = window.writeflex.collection.onChanged(() => { void reload() })
    const session = window.writeflex.diary.onSession(() => { void reload() })
    const automatic = window.writeflex.diary.onAutomaticSession(() => { void reload() })
    return () => { disposed = true; clearInterval(timer); off(); session(); automatic() }
  }, [dir])
  if (error) return <p className="rail-error" role="alert">{error}</p>
  if (!glance) return null
  if (!glance.designated) return <button type="button" className="diary-invitation" onClick={onSettings}>Choose a Diary in Settings → Diary</button>
  if (!glance.counted) return null
  return <section aria-label="Diary glance">
    <h2 className="rail-section-label">Diary</h2>
    <div className="rail-card diary-glance">
      <div className="dg-num">{glance.todayWords.toLocaleString('en-GB')}</div>
      <div className="dg-unit">net words today</div>
      <div className="dg-day">day {glance.streak}</div>
      <div className="dg-dots" aria-label="Writing days in the last 14 days">
        {glance.days.map((day, index) => <span key={day.date} className={!day.written ? 'off' : index === 13 ? 'today' : ''} title={`${day.date}: ${day.written ? 'written' : 'no session'}`} aria-label={`${day.date}: ${day.written ? 'written' : 'no session'}`} />)}
      </div>
      <div className="dg-now"><Clock size={12} aria-hidden="true" />{glance.sessionLine}</div>
    </div>
  </section>
}
