import { AUTH_CHANNELS, type AuthProviderEntry, type AuthTransport, type AuthUiEvent } from "./contract.ts";

/** Minimal shape of Electron's `ipcRenderer`. */
export type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
};

/** Build the legacy auth-only renderer transport without importing main-process code. */
export function createAuthTransport(ipc: IpcRendererLike): AuthTransport {
  return {
    providers: () => ipc.invoke(AUTH_CHANNELS.providers) as Promise<AuthProviderEntry[]>,
    login: (providerId, method) => ipc.invoke(AUTH_CHANNELS.login, { providerId, method }) as Promise<void>,
    cancel: () => ipc.invoke(AUTH_CHANNELS.cancel) as Promise<void>,
    respond: (requestId, value) => ipc.invoke(AUTH_CHANNELS.respond, { requestId, value }) as Promise<boolean>,
    setApiKey: (providerId, key) => ipc.invoke(AUTH_CHANNELS.setApiKey, { providerId, key }) as Promise<AuthProviderEntry[]>,
    logout: (providerId) => ipc.invoke(AUTH_CHANNELS.logout, providerId) as Promise<AuthProviderEntry[]>,
    subscribe: (listener) => {
      const handler = (_event: unknown, payload: AuthUiEvent): void => listener(payload);
      ipc.on(AUTH_CHANNELS.event, handler);
      return () => ipc.removeListener(AUTH_CHANNELS.event, handler);
    },
  };
}
