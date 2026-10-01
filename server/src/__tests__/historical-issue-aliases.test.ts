import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHistoricalIssueAlias } from "../services/historical-issue-aliases.js";

describe("historical issue alias snapshots", () => {
  let directory: string;
  let file: string;
  const entry = { legacy: "OLD-7", id: randomUUID(), companyId: randomUUID(), current: "NEW-7" };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-issue-aliases-"));
    file = path.join(directory, "aliases.json");
    vi.stubEnv("PAPERCLIP_ISSUE_ALIASES_FILE", file);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("supports existing snapshot format without requiring business data in source", async () => {
    await writeFile(file, JSON.stringify({ aliases: [entry], missing: [] }));
    await expect(getHistoricalIssueAlias("old-7")).resolves.toEqual({
      issueId: entry.id, companyId: entry.companyId, issueNumber: 7,
    });
    await expect(getHistoricalIssueAlias("OLD-8")).resolves.toBeNull();
  });

  it("is disabled unless the host server explicitly configures a snapshot", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_ALIASES_FILE", undefined);
    await expect(getHistoricalIssueAlias("OLD-7")).resolves.toBeNull();
  });

  it.each([
    ["missing array", {}],
    ["invalid ID", { aliases: [{ ...entry, id: "invalid" }] }],
    ["missing company", { aliases: [{ legacy: entry.legacy, id: entry.id }] }],
    ["invalid company", { aliases: [{ ...entry, companyId: "invalid" }] }],
    ["unsafe issue number", { aliases: [{ ...entry, legacy: "OLD-9007199254740992" }] }],
    ["duplicate identifier", { aliases: [entry, { ...entry, legacy: "old-7" }] }],
  ])("rejects %s without disclosing mappings", async (_name, value) => {
    await writeFile(file, JSON.stringify(value));
    await expect(getHistoricalIssueAlias("OLD-7")).rejects.toMatchObject({
      status: 422, details: { code: "issue_alias_configuration_invalid" },
    });
  });

  it("reports unreadable files using a generic configuration error", async () => {
    await expect(getHistoricalIssueAlias("OLD-7")).rejects.toThrow("The server's historical issue alias configuration needs repair");
  });

  it("rejects malformed, relative, symlinked and oversized files", async () => {
    await writeFile(file, "private malformed content");
    await expect(getHistoricalIssueAlias("OLD-7")).rejects.toThrow("configuration needs repair");
    vi.stubEnv("PAPERCLIP_ISSUE_ALIASES_FILE", "aliases.json");
    await expect(getHistoricalIssueAlias("OLD-7")).rejects.toThrow("configuration needs repair");
    const link = path.join(directory, "link.json");
    await symlink(file, link);
    vi.stubEnv("PAPERCLIP_ISSUE_ALIASES_FILE", link);
    await expect(getHistoricalIssueAlias("OLD-7")).rejects.toThrow("configuration needs repair");
    vi.stubEnv("PAPERCLIP_ISSUE_ALIASES_FILE", file);
    await writeFile(file, " ".repeat(1024 * 1024 + 1));
    await expect(getHistoricalIssueAlias("OLD-7")).rejects.toThrow("configuration needs repair");
  });
});
