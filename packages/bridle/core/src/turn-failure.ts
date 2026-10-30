import type { TurnEndReason } from "./events.ts";

/** Structured transport evidence takes precedence over message fallback text. */
export function turnFailureReason(error: unknown, userAborted = false): TurnEndReason {
  if (userAborted) return "aborted";
  const seen = new Set<unknown>();
  const classify = (error: unknown): TurnEndReason => {
    if (seen.has(error)) return "provider-error";
    seen.add(error);
    const value = error && typeof error === "object" ? error as { status?: number; statusCode?: number; code?: string; name?: string; message?: string; errorMessage?: unknown; kind?: string; stopReason?: string; cause?: unknown } : {};
    const status = value.status ?? value.statusCode;
    if (status !== undefined) return status === 401 || status === 403 ? "auth" : "provider-error";
    if (value.code === "auth" || value.code === "oauth_refresh" || value.code === "invalid_grant" || value.code === "invalid_api_key" || value.kind === "auth") return "auth";
    if (value.stopReason === "aborted" || value.name === "AbortError" || value.code === "ABORT_ERR" || value.kind === "network" || /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR)/.test(value.code ?? "")) return "network";
    if (value.cause) return classify(value.cause);
    if (value.errorMessage !== undefined) return classify(value.errorMessage);
    const text = value.message ?? (typeof error === "string" ? error : "");
    if (/^(?:HTTP(?: status)?[: ]*)?(?:401|403)\b|\bunauthori[sz]ed\b|not signed in|no api key|expired.*(token|sign.in)|authentication failed|refresh.*(failed|refused)/i.test(text)) return "auth";
    if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|fetch failed|network|connection (lost|error|closed)|socket|offline|timed? ?out/i.test(text)) return "network";
    return "provider-error";
  };
  return classify(error);
}
