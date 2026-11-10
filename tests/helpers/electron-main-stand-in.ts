/** Import surface for isolated main-process probes. Each probe supplies its own IPC, app and I/O seams. */
export const electronMainStandIn = {
  BrowserWindow: class {
    static getFocusedWindow(): null { return null }
    static getAllWindows(): never[] { return [] }
  },
  webFrameMain: { fromId: () => null },
  Menu: {},
  net: {},
  session: {},
}
