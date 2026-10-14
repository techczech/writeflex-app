import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthFlowController, AuthFlowState, AuthInputRequest } from "@bridle/react";
import type { AuthProviderEntry, AuthTransport, AuthUiEvent } from "./contract.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fold a pushed broker event into the AuthFlow state machine. Pure — exported for testing. */
export function authStateForEvent(_state: AuthFlowState, event: AuthUiEvent): AuthFlowState {
  switch (event.kind) {
    case "login-finished":
      return event.ok
        ? { phase: "complete", providerId: event.providerId }
        : { phase: "error", providerId: event.providerId, message: event.error ?? "Authentication failed." };
    case "auth-url":
      return { phase: "auth-url", providerId: event.providerId, url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
    case "device-code":
      return { phase: "device-code", providerId: event.providerId, userCode: event.userCode, verificationUri: event.verificationUri };
    case "progress":
      return { phase: "progress", providerId: event.providerId, message: event.message };
    case "input-request": {
      const request: AuthInputRequest = {
        requestId: event.requestId,
        inputKind: event.inputKind,
        ...(event.message ? { message: event.message } : {}),
        ...(event.placeholder ? { placeholder: event.placeholder } : {}),
        ...(event.options ? { options: event.options } : {}),
      };
      return { phase: "input", providerId: event.providerId, request };
    }
  }
}

/**
 * Renderer-side hook that produces an `AuthFlowController` (the shape `@bridle/react`'s AuthFlow
 * component consumes) backed by an IPC transport instead of an in-process Bridle handle. This is
 * what lets an Electron app render the real AuthFlow even though the live Bridle handle is main-only.
 */
/** The AuthFlowController @bridle/react's AuthFlow consumes, plus a `cancel()` that truly
 *  aborts an in-flight login (so a retry after Cancel doesn't collide on the OAuth callback). */
export type IpcAuthFlowController = AuthFlowController & { cancel: () => void };

export function useIpcAuthFlow(transport: AuthTransport, options: { defaultProviderId?: string } = {}): IpcAuthFlowController {
  const fallbackProviderId = options.defaultProviderId ?? "openai-codex";
  const [state, setState] = useState<AuthFlowState>({ phase: "idle" });
  const [providers, setProviders] = useState<AuthProviderEntry[]>([]);

  const refreshProviders = useCallback(async (): Promise<void> => {
    setProviders(await transport.providers());
  }, [transport]);

  useEffect(() => {
    void refreshProviders().catch((error: unknown) => {
      setState({ phase: "error", providerId: fallbackProviderId, message: errorMessage(error) });
    });
    return transport.subscribe((event) => {
      setState((current) => authStateForEvent(current, event));
      if (event.kind === "login-finished") void refreshProviders();
    });
  }, [transport, refreshProviders, fallbackProviderId]);

  // Default to the browser login method so the provider's Browser/Device select is
  // pre-answered rather than surfaced as a blocking prompt. Callers can pass "device_code".
  const login = useCallback(async (providerId: string, method: string = "browser"): Promise<void> => {
    setState({ phase: "authorising", providerId });
    try {
      await transport.login(providerId, method);
    } catch (error) {
      setState({ phase: "error", providerId, message: errorMessage(error) });
    }
  }, [transport]);

  const respond = useCallback((requestId: string, value: string | undefined): boolean => {
    let pending = false;
    setState((current) => {
      pending = current.phase === "input" && current.request.requestId === requestId;
      return current;
    });
    if (pending) void transport.respond(requestId, value);
    return pending;
  }, [transport]);

  const setApiKey = useCallback((providerId: string, key: string): void => {
    const trimmed = key.trim();
    if (!trimmed) {
      setState({ phase: "error", providerId, message: "API key is required." });
      return;
    }
    void transport.setApiKey(providerId, trimmed)
      .then((next) => {
        setProviders(next);
        setState({ phase: "complete", providerId });
      })
      .catch((error: unknown) => {
        setState({ phase: "error", providerId, message: errorMessage(error) });
      });
  }, [transport]);

  const cancel = useCallback((): void => {
    void transport.cancel();
    setState({ phase: "idle" });
  }, [transport]);

  const logout = useCallback((providerId: string): void => {
    void transport.logout(providerId)
      .then((next) => {
        setProviders(next);
        setState({ phase: "idle" });
      })
      .catch((error: unknown) => {
        setState({ phase: "error", providerId, message: errorMessage(error) });
      });
  }, [transport]);

  return useMemo(
    () => ({ state, providers, login, respond, setApiKey, logout, cancel }),
    [state, providers, login, respond, setApiKey, logout, cancel],
  );
}
