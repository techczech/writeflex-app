export function packagedSmokeRequested(environment: NodeJS.ProcessEnv): boolean {
  return environment.WRITEFLEX_E2E === '1' && environment.WRITEFLEX_E2E_SMOKE === '1'
}

export const packagedSmokeIpcProbe = 'window.writeflex.getAppVersion()'

export function exitPackagedSmoke(exit: (code: number) => void, code: number): void {
  exit(code)
}

export function packagedSmokeReceiptObserved(output: string): boolean {
  return output.includes('WRITEFLEX_SMOKE=')
}

export function packagedSmokeReceipt(input: { ipcVersion: string; userData: string; version: string; visible: boolean }): string {
  return `WRITEFLEX_SMOKE=${JSON.stringify({
    mainProcess: 'live',
    renderer: 'loaded',
    ipcRoundTrip: 'app:version',
    ipcVersion: input.ipcVersion,
    userData: input.userData,
    version: input.version,
    visible: input.visible,
  })}`
}
