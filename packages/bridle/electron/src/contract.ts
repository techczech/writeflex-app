import type { ProviderInfo } from "@bridle/core";

/**
 * A provider entry exactly as `@bridle/react`'s AuthFlow component consumes it:
 * the framework's ProviderInfo merged with the credential status from BridleAuth.
 * This is the same shape `useAuthFlow` produces in-process — we reproduce it across
 * the Electron main↔renderer boundary so the same component works unchanged.
 */
export type AuthProviderEntry = ProviderInfo & { configured: boolean; label?: string };

/**
 * Interactive events streamed from the main-process broker to the renderer while an
 * OAuth login is in flight. OAuth is not request/response — it needs a push channel.
 */
export type AuthUiEvent =
  | { kind: "auth-url"; providerId: string; url: string; instructions?: string }
  | { kind: "device-code"; providerId: string; userCode: string; verificationUri: string }
  | { kind: "progress"; providerId: string; message: string }
  | {
      kind: "input-request";
      providerId: string;
      requestId: string;
      inputKind: "prompt" | "select" | "manual-code";
      message?: string;
      placeholder?: string;
      options?: { id: string; label: string }[];
    }
  | { kind: "login-finished"; providerId: string; ok: boolean; error?: string };

/**
 * The renderer-side transport a host app exposes over its preload bridge.
 * `createAuthTransport(ipcRenderer)` produces one; `useIpcAuthFlow` consumes it.
 */
export type AuthTransport = {
  providers(): Promise<AuthProviderEntry[]>;
  /** `method` pre-answers the provider's login-method choice (e.g. "browser" / "device_code"). */
  login(providerId: string, method?: string): Promise<void>;
  /** Abort an in-flight login so a retry doesn't collide (frees the OAuth callback server). */
  cancel(): Promise<void>;
  respond(requestId: string, value: string | undefined): Promise<boolean>;
  setApiKey(providerId: string, key: string): Promise<AuthProviderEntry[]>;
  logout(providerId: string): Promise<AuthProviderEntry[]>;
  subscribe(listener: (event: AuthUiEvent) => void): () => void;
};

/** Standard IPC channel names owned by @bridle/electron (main + preload agree via these). */
export const AUTH_CHANNELS = {
  providers: "bridle.auth:providers",
  login: "bridle.auth:login",
  cancel: "bridle.auth:cancel",
  respond: "bridle.auth:respond",
  setApiKey: "bridle.auth:set-api-key",
  logout: "bridle.auth:logout",
  event: "bridle.auth:event",
} as const;
