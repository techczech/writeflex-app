declare module "electron" {
  export const ipcRenderer: import("./preload-auth.ts").IpcRendererLike;
}
