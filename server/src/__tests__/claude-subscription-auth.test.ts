import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_REFRESH_BUFFER_MS, parseClaudeSubscriptionCredential, refreshClaudeSubscriptionCredential } from "../services/claude-subscription-auth.js";

const now = 1_900_000_000_000;
const credential = (fields: Record<string, unknown> = {}) => JSON.stringify({ claudeAiOauth: {
  accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now - 1,
  scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "fixture-tier", ...fields,
} });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("managed Claude subscription renewal", () => {
  it("uses the first-party CLI refresh protocol and retains account metadata", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh",
      expires_in: 28800, refresh_token_expires_in: 604800, scope: "user:inference user:profile" })));
    vi.stubGlobal("fetch", fetch);
    const result = await refreshClaudeSubscriptionCredential(credential());
    expect(result.accessToken).toBe("new-access");
    expect(parseClaudeSubscriptionCredential(result.value)).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh",
      expiresAt: now + 28800 * 1000, refreshTokenExpiresAt: now + 604800 * 1000,
      subscriptionType: "max", rateLimitTier: "fixture-tier", scopes: ["user:inference", "user:profile"] });
    expect(fetch).toHaveBeenCalledWith("https://platform.claude.com/v1/oauth/token", expect.objectContaining({ method: "POST", redirect: "error" }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ grant_type: "refresh_token", refresh_token: "old-refresh",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope: "user:inference user:profile" });
  });
  it("retains the refresh token and scope when the provider omits unchanged fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "new", expires_in: 28800 }))));
    const result = await refreshClaudeSubscriptionCredential(credential({ clientId: "selected-client" }), now);
    expect(parseClaudeSubscriptionCredential(result.value)).toMatchObject({ refreshToken: "old-refresh", scopes: ["user:inference", "user:profile"], clientId: "selected-client" });
  });
  it("refreshes near expiry before launch, but leaves a fresh credential untouched", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "new", expires_in: 28800 })));
    vi.stubGlobal("fetch", fetch);
    const fresh = credential({ expiresAt: now + CLAUDE_REFRESH_BUFFER_MS + 1 });
    expect(await refreshClaudeSubscriptionCredential(fresh, now)).toEqual({ value: fresh, accessToken: "old-access" });
    expect(fetch).not.toHaveBeenCalled();
    await refreshClaudeSubscriptionCredential(credential({ expiresAt: now + CLAUDE_REFRESH_BUFFER_MS }), now);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("supports legacy access-only tokens without silently inventing renewal", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await refreshClaudeSubscriptionCredential("legacy-setup-token", now)).toEqual({ value: "legacy-setup-token", accessToken: "legacy-setup-token" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["{broken", "[]", "null", "true", '"quoted-token"', credential({ expiresAt: "wrong" }), credential({ expiresAt: 1e308 }), credential({ refreshToken: undefined }),
    credential({ scopes: [] }), credential({ refreshTokenExpiresAt: now - 1 })])("asks for a new Paperclip sign-in for an unusable credential", async value => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(refreshClaudeSubscriptionCredential(value, now)).rejects.toThrow("Reconnect this Claude subscription in Paperclip");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403])("redacts the provider's authentication rejection (HTTP %i)", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider echoed old-access old-refresh", { status })));
    await expect(refreshClaudeSubscriptionCredential(credential(), now)).rejects.toThrow(/^Reconnect this Claude subscription in Paperclip/);
  });
  it("reports transient provider/network failures without credential-bearing errors", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("old-refresh", { status: 503 })).mockRejectedValueOnce(new Error("old-access old-refresh"));
    vi.stubGlobal("fetch", fetch);
    await expect(refreshClaudeSubscriptionCredential(credential(), now)).rejects.toThrow("temporarily unavailable");
    await expect(refreshClaudeSubscriptionCredential(credential(), now)).rejects.toThrow("could not reach the provider");
  });
  it.each(["not json", JSON.stringify({ access_token: "new", expires_in: "wrong" }), JSON.stringify({ access_token: "new", expires_in: 0 }),
    JSON.stringify({ access_token: "new", expires_in: 1e308 }), JSON.stringify({ access_token: "new", expires_in: 28800, refresh_token_expires_in: 1e308 }),
    JSON.stringify({ access_token: "new", expires_in: 28800, scope: "   " })])("rejects malformed success responses without returning their contents", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(refreshClaudeSubscriptionCredential(credential(), now)).rejects.toThrow("Reconnect this Claude subscription");
  });
});
