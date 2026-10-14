import { useEffect, useState } from 'react'
import { useIpcAuthFlow } from '@bridle/electron/renderer'
import type { ConnectionSources } from '../../../shared/guide-connections'
import type { SpeechVoiceInfo } from '../editor/speech-engine'

/** The platform's voice list, as the read-aloud engine maps it. Empty until the platform has loaded them. */
export function readSystemVoices(): SpeechVoiceInfo[] {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis
  return (synth?.getVoices() ?? []).map((voice) => ({ uri: voice.voiceURI, name: voice.name, lang: voice.lang, isDefault: voice.default }))
}

/**
 * The Guide's three connection sources, read from this machine and never written: the agent's providers
 * (the auth flow's `configured` flags), whether Zotero's database is on this Mac (asked of main), and the
 * system voices. `enabled` false (no Guide in this window) asks for nothing. The voice list can load after the
 * first read, so it is re-read when the platform says so; if the platform has none after a moment it is empty.
 */
export function useGuideConnectionSources(enabled: boolean): ConnectionSources {
  const auth = useIpcAuthFlow(window.writeflex.auth, { defaultProviderId: 'openai-codex' })
  const [zoteroFound, setZoteroFound] = useState<boolean | null>(null)
  const [voices, setVoices] = useState<SpeechVoiceInfo[] | null>(null)

  useEffect(() => {
    if (!enabled) return
    let live = true
    void window.writeflex.getGuideConnections().then((answer) => { if (live) setZoteroFound(answer.zotero) }).catch(() => { if (live) setZoteroFound(false) })
    return () => { live = false }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis
    const read = (): void => { const now = readSystemVoices(); if (now.length > 0) setVoices(now) }
    read()
    synth?.addEventListener?.('voiceschanged', read)
    const settle = setTimeout(() => setVoices((now) => now ?? []), 1200)
    return () => { synth?.removeEventListener?.('voiceschanged', read); clearTimeout(settle) }
  }, [enabled])

  return { providers: auth.providers.length === 0 ? null : auth.providers.map((provider) => ({ id: provider.id, configured: provider.configured })), zoteroFound, voices }
}
