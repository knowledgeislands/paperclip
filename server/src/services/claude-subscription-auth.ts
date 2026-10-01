import { unprocessable } from "../errors.js";

// Matches Claude Code 2.1.280's first-party OAuth client and refresh protocol.
// These are public protocol constants, never a caller-controlled URL.
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export interface ClaudeSubscriptionCredential extends Record<string, unknown> {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  clientId?: string;
}

export function parseClaudeSubscriptionCredential(value: string): ClaudeSubscriptionCredential | null {
  if (Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth) ||
        typeof oauth.accessToken !== "string" || !oauth.accessToken.trim()) return null;
    if (oauth.refreshToken !== undefined && (typeof oauth.refreshToken !== "string" || !oauth.refreshToken.trim())) return null;
    if (oauth.expiresAt !== undefined && (typeof oauth.expiresAt !== "number" || !Number.isSafeInteger(oauth.expiresAt) || oauth.expiresAt <= 0 || oauth.expiresAt > 8_640_000_000_000_000)) return null;
    if (oauth.scopes !== undefined && (!Array.isArray(oauth.scopes) || oauth.scopes.some((scope: unknown) => typeof scope !== "string" || !scope.trim()))) return null;
    if (oauth.clientId !== undefined && (typeof oauth.clientId !== "string" || !oauth.clientId.trim())) return null;
    return oauth;
  } catch { return null; }
}

export function serializeClaudeSubscriptionCredential(oauth: ClaudeSubscriptionCredential): string {
  // Keep subscription/account metadata, but never copy unrelated CLI secrets.
  return JSON.stringify({ claudeAiOauth: oauth });
}

function reconnectRequired() {
  return unprocessable("Reconnect this Claude subscription in Paperclip with a separate sign-in so its login can renew.",
    { code: "ai_connection_reauthorization_required" });
}

/** Caller must serialize refresh and persistence for the originating secret. */
export async function refreshClaudeSubscriptionCredential(value: string, now = Date.now()): Promise<{ value: string; accessToken: string }> {
  const oauth = parseClaudeSubscriptionCredential(value);
  if (!oauth) {
    // Previously imported access-only/setup tokens remain compatible. JSON is
    // never used as a Bearer token, even when corrupt or from another provider.
    if (!value.trim() || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES || /\s/.test(value) || /^[{[\"]/.test(value)) throw reconnectRequired();
    let isJson = false;
    try { JSON.parse(value); isJson = true; } catch { /* Legacy opaque token. */ }
    if (isJson) throw reconnectRequired();
    return { value, accessToken: value };
  }
  if (oauth.expiresAt === undefined) {
    if (oauth.refreshToken) throw reconnectRequired();
    return { value, accessToken: oauth.accessToken };
  }
  if (oauth.expiresAt > now + CLAUDE_REFRESH_BUFFER_MS) return { value, accessToken: oauth.accessToken };
  if (!oauth.refreshToken || !oauth.scopes?.length) throw reconnectRequired();
  const refreshExpiry = oauth.refreshTokenExpiresAt;
  if (typeof refreshExpiry === "number" && refreshExpiry <= now) throw reconnectRequired();

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken,
        client_id: oauth.clientId ?? CLIENT_ID, scope: oauth.scopes.join(" ") }),
    });
  } catch {
    throw unprocessable("Claude login renewal could not reach the provider. Retry when the connection is available.",
      { code: "ai_connection_refresh_unavailable" });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if ([400, 401, 403].includes(response.status)) throw reconnectRequired();
    throw unprocessable("Claude login renewal is temporarily unavailable. Retry later.",
      { code: "ai_connection_refresh_unavailable" });
  }
  // Never include provider bodies or parser errors in exceptions/logs.
  let result: Record<string, unknown>;
  try { result = await response.json(); } catch { throw reconnectRequired(); }
  if (!result || typeof result !== "object" || typeof result.access_token !== "string" || !result.access_token.trim() ||
      typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0 ||
      (result.refresh_token !== undefined && (typeof result.refresh_token !== "string" || !result.refresh_token.trim())) ||
      (result.scope !== undefined && (typeof result.scope !== "string" || !result.scope.trim()))) throw reconnectRequired();
  const refreshedAt = Date.now();
  const expiresAt = refreshedAt + result.expires_in * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > 8_640_000_000_000_000) throw reconnectRequired();
  const refreshed: ClaudeSubscriptionCredential = { ...oauth, accessToken: result.access_token,
    refreshToken: (result.refresh_token as string | undefined) ?? oauth.refreshToken,
    expiresAt,
    scopes: typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : oauth.scopes };
  if (typeof result.refresh_token_expires_in === "number" && Number.isFinite(result.refresh_token_expires_in) && result.refresh_token_expires_in > 0) {
    const refreshExpiresAt = refreshedAt + result.refresh_token_expires_in * 1000;
    if (!Number.isSafeInteger(refreshExpiresAt) || refreshExpiresAt > 8_640_000_000_000_000) throw reconnectRequired();
    refreshed.refreshTokenExpiresAt = refreshExpiresAt;
  }
  else if (result.refresh_token !== undefined && result.refresh_token !== oauth.refreshToken)
    delete refreshed.refreshTokenExpiresAt;
  return { value: serializeClaudeSubscriptionCredential(refreshed), accessToken: refreshed.accessToken };
}
