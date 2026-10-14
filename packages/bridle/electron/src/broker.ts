import { randomUUID } from "node:crypto";
import { BridleAuth, getOAuthProviders, listProviders, type OAuthLoginCallbacks } from "@bridle/core";
import type { AuthProviderEntry, AuthUiEvent } from "./contract.ts";

export type AuthBrokerIo = {
  /** Open the OAuth authorisation URL in the user's browser (Electron shell.openExternal). */
  openExternal: (url: string) => void;
  /** Push an interactive login event to the renderer (webContents.send over AUTH_CHANNELS.event). */
  emit: (event: AuthUiEvent) => void;
};

export type AuthBrokerOptions = {
  /**
   * Restrict/extend the provider list (passed straight to listProviders). Defaults to
   * Bridle's curated allowlist (anthropic, openai, openai-codex, google, github-copilot).
   */
  include?: string[];
};

/**
 * Main-process auth broker. Drives BridleAuth's login/setApiKey/status/logout and bridges
 * the interactive OAuth callbacks to a UI event stream. Transport-agnostic: `registerAuthIpc`
 * wires it to an ipcMain, and the host supplies `io.emit`/`io.openExternal`. This is the piece
 * that used to be hand-rolled per Electron app; it now lives in the framework.
 */
export class AuthFlowBroker {
  #pending = new Map<string, (value: string | undefined) => void>();
  #abort: AbortController | null = null;
  readonly #auth: BridleAuth;
  readonly #io: AuthBrokerIo;
  readonly #include: string[] | undefined;

  constructor(auth: BridleAuth, io: AuthBrokerIo, options: AuthBrokerOptions = {}) {
    this.#auth = auth;
    this.#io = io;
    this.#include = options.include;
  }

  /** The full provider catalogue merged with credential status — the exact shape
   *  `@bridle/react`'s AuthFlow expects. OAuth-capable providers surface an "oauth" lane. */
  providers(): AuthProviderEntry[] {
    const listed = listProviders(this.#include ? { include: this.#include } : undefined);
    return listed.map((provider) => {
      // Explicit merge: an undefined status.label must NOT clobber the catalogue label
      // (the naive spread `{...provider, ...status}` does — a latent bug in useAuthFlow).
      const status = this.#auth.status(provider.id);
      return { ...provider, configured: status.configured, label: status.label ?? provider.label };
    });
  }

  /** Provider ids the framework can actually complete an OAuth login for. */
  oauthProviderIds(): string[] {
    return getOAuthProviders().map((provider) => provider.id);
  }

  /**
   * @param options.method  Pre-answer the provider's login-method choice (e.g. "browser" or
   *   "device_code") when it offers one, so the UI can default to browser without surfacing
   *   Pi's Browser/Device select as a blocking prompt. Ignored if the provider does not offer
   *   a matching option (the select is then emitted normally).
   */
  async login(providerId: string, options: { method?: string } = {}): Promise<void> {
    const abort = new AbortController();
    this.#abort = abort;
    const request = (
      inputKind: "prompt" | "select" | "manual-code",
      extra: { message?: string; placeholder?: string; options?: { id: string; label: string }[] } = {},
    ): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        const requestId = randomUUID();
        this.#pending.set(requestId, resolve);
        this.#io.emit({ kind: "input-request", providerId, requestId, inputKind, ...extra });
      });

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        this.#io.openExternal(info.url);
        this.#io.emit({ kind: "auth-url", providerId, url: info.url, ...(info.instructions ? { instructions: info.instructions } : {}) });
      },
      onDeviceCode: (info) => this.#io.emit({ kind: "device-code", providerId, userCode: info.userCode, verificationUri: info.verificationUri }),
      onProgress: (message) => this.#io.emit({ kind: "progress", providerId, message }),
      onPrompt: async (prompt) => (await request("prompt", { message: prompt.message, placeholder: prompt.placeholder })) ?? "",
      onSelect: (prompt) => {
        const preset = options.method ? prompt.options?.find((option) => option.id === options.method) : undefined;
        return preset ? Promise.resolve<string | undefined>(preset.id) : request("select", { message: prompt.message, options: prompt.options });
      },
      onManualCodeInput: async () => (await request("manual-code", { message: "Paste the redirect URL or authorisation code" })) ?? "",
      signal: abort.signal,
    };

    try {
      await this.#auth.login(providerId, callbacks);
      this.#io.emit({ kind: "login-finished", providerId, ok: true });
    } catch (error) {
      this.#io.emit({ kind: "login-finished", providerId, ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      // Only clear if a later login() hasn't already replaced this attempt's controller.
      if (this.#abort === abort) this.#abort = null;
      for (const resolve of this.#pending.values()) resolve(undefined);
      this.#pending.clear();
    }
  }

  /**
   * Abort an in-flight login. Aborts the provider's OAuth flow via its AbortSignal — Pi
   * closes the local callback server (localhost:1455) and rejects the login — so a retry
   * gets a fresh state and a free port instead of a "state mismatch" collision.
   */
  cancel(): void {
    this.#abort?.abort();
    this.#abort = null;
    for (const resolve of this.#pending.values()) resolve(undefined);
    this.#pending.clear();
  }

  respond(requestId: string, value: string | undefined): boolean {
    const resolve = this.#pending.get(requestId);
    if (!resolve) return false;
    this.#pending.delete(requestId);
    resolve(value);
    return true;
  }

  setApiKey(providerId: string, key: string): AuthProviderEntry[] {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("API key is required.");
    this.#auth.setApiKey(providerId, trimmed);
    return this.providers();
  }

  logout(providerId: string): AuthProviderEntry[] {
    this.#auth.logout(providerId);
    return this.providers();
  }
}
