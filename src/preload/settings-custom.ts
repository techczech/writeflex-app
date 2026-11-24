import { contextBridge, ipcRenderer } from 'electron'
import type { WriteFlexApi } from './index'
import { updateNoticesApi } from './update-notices'
import { BACKUP_GITHUB_CHANNELS } from '../shared/backup-github'
import { BACKUP_ENROLMENT_CHANNELS } from '../shared/backup-enrolment'

// Only app-level Settings operations. No editor or arbitrary filesystem capability.
const api = {
  ...updateNoticesApi,
  setSetting: (key, value, _label) => ipcRenderer.invoke('wf-settings-window:set', { key, value }),
  installCommandLineTool: () => ipcRenderer.invoke('cli:install'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getRuntimeInfo: () => ipcRenderer.invoke('app:runtime-info'),
  copyToClipboard: (markdown, kind, path) => ipcRenderer.invoke('clipboard:copy', { markdown, kind, path }),
  readingRoom: { getReaderNotices: () => ipcRenderer.invoke('reading-room:get-reader-notices') },
  scratchpad: { externalStatus: (input) => ipcRenderer.invoke('wf-settings-window:source-status', input) },
  agentSkill: {
    status: () => ipcRenderer.invoke('agent-skill:status'),
    offer: () => ipcRenderer.invoke('agent-skill:offer'),
    install: (ids) => ipcRenderer.invoke('agent-skill:install', ids),
    remove: (ids) => ipcRenderer.invoke('agent-skill:remove', ids),
    replace: (ids) => ipcRenderer.invoke('agent-skill:replace', ids),
    decline: (ids) => ipcRenderer.invoke('agent-skill:decline', ids),
    answerOffer: (answer) => ipcRenderer.invoke('agent-skill:answer-offer', answer),
    offerShown: (ids) => ipcRenderer.invoke('agent-skill:offer-shown', ids),
  },
  backupGitHub: {
    status: () => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.status),
    connect: () => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.connect),
    cancel: (input) => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.cancel, { attemptId: input.attemptId }),
    openBrowser: (input) => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.openBrowser, { attemptId: input.attemptId }),
    repository: () => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.repository),
    useRepository: (input) => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.useRepository, { candidateId: input.candidateId }),
    openRepositoryAccess: () => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.openRepositoryAccess),
    disconnect: () => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.disconnect),
    openAuthorisations: () => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.openAuthorisations),
    recover: () => ipcRenderer.invoke(BACKUP_GITHUB_CHANNELS.recover),
    onChanged: (fn) => { const listener = () => fn(); ipcRenderer.on(BACKUP_GITHUB_CHANNELS.changed, listener); return () => { ipcRenderer.removeListener(BACKUP_GITHUB_CHANNELS.changed, listener) } },
  },
  backupEnrolment: {
    status: () => ipcRenderer.invoke(BACKUP_ENROLMENT_CHANNELS.status),
    preview: () => ipcRenderer.invoke(BACKUP_ENROLMENT_CHANNELS.preview),
    enable: (input) => ipcRenderer.invoke(BACKUP_ENROLMENT_CHANNELS.enable, { previewId: String(input.previewId), confirmPublic: input.confirmPublic === true }),
    confirmEarlier: (input) => ipcRenderer.invoke(BACKUP_ENROLMENT_CHANNELS.confirmEarlier, { previewId: String(input.previewId), confirmEarlier: input.confirmEarlier === true }),
    disable: () => ipcRenderer.invoke(BACKUP_ENROLMENT_CHANNELS.disable),
    onChanged: (fn) => {
      const listener = (): void => fn()
      ipcRenderer.on(BACKUP_ENROLMENT_CHANNELS.changed, listener)
      return () => { ipcRenderer.removeListener(BACKUP_ENROLMENT_CHANNELS.changed, listener) }
    },
  },
  sharing: {
    status: (options) => ipcRenderer.invoke('sharing:status', { askService: options?.askService === true }),
    checkToken: (token) => ipcRenderer.invoke('sharing:check-token', token),
    checkSavedToken: () => ipcRenderer.invoke('sharing:check-saved-token'),
    chooseAccount: (accountId) => ipcRenderer.invoke('sharing:choose-account', accountId),
    setUp: () => ipcRenderer.invoke('sharing:set-up'),
    removalConfirmation: () => ipcRenderer.invoke('sharing:removal-confirmation'),
    remove: (request) => ipcRenderer.invoke('sharing:remove', { confirmation: request.confirmation }),
    openCloudflare: () => ipcRenderer.invoke('sharing:open-cloudflare'),
    domains: () => ipcRenderer.invoke('sharing:domains'),
    attachAddress: (request) => ipcRenderer.invoke('sharing:attach-address', { name: request.name, domain: request.domain }),
    removeAddress: () => ipcRenderer.invoke('sharing:remove-address'),
  },
} satisfies Pick<WriteFlexApi, 'updates' | 'setSetting' | 'installCommandLineTool' | 'getAppVersion' | 'getRuntimeInfo' | 'copyToClipboard' | 'agentSkill' | 'backupGitHub' | 'backupEnrolment'> & {
  readingRoom: Pick<WriteFlexApi['readingRoom'], 'getReaderNotices'>
  scratchpad: Pick<WriteFlexApi['scratchpad'], 'externalStatus'>
  sharing: Pick<WriteFlexApi['sharing'], 'status' | 'checkToken' | 'checkSavedToken' | 'chooseAccount' | 'setUp' | 'removalConfirmation' | 'remove' | 'openCloudflare' | 'domains' | 'attachAddress' | 'removeAddress'>
}
contextBridge.exposeInMainWorld('writeflex', api)
