import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { unprocessable } from "../errors.js";

const MAX_ALIAS_FILE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/;

export interface HistoricalIssueAlias {
  issueId: string;
  companyId: string;
  issueNumber: number;
}

function invalidConfiguration() {
  // Neither file paths nor mapping contents belong in an API error.
  return unprocessable("The server's historical issue alias configuration needs repair", {
    code: "issue_alias_configuration_invalid",
  });
}

function parseAliases(value: unknown): Map<string, HistoricalIssueAlias> {
  if (!value || typeof value !== "object" || !Array.isArray((value as { aliases?: unknown }).aliases)) {
    throw invalidConfiguration();
  }
  const result = new Map<string, HistoricalIssueAlias>();
  for (const row of (value as { aliases: unknown[] }).aliases) {
    if (!row || typeof row !== "object") throw invalidConfiguration();
    const { legacy, id, companyId } = row as Record<string, unknown>;
    const identifier = typeof legacy === "string" ? legacy.toUpperCase() : "";
    const match = IDENTIFIER.exec(identifier);
    const issueNumber = match ? Number(match[2]) : NaN;
    if (!match || !Number.isSafeInteger(issueNumber) ||
        typeof id !== "string" || !UUID.test(id) ||
        typeof companyId !== "string" || !UUID.test(companyId) ||
        result.has(identifier)) {
      throw invalidConfiguration();
    }
    result.set(identifier, { issueId: id, companyId, issueNumber });
  }
  return result;
}

/** Host-owned runtime data only; never read an agent's env or project configuration. */
export async function getHistoricalIssueAlias(identifier: string): Promise<HistoricalIssueAlias | null> {
  const file = process.env.PAPERCLIP_ISSUE_ALIASES_FILE;
  if (!file) return null;
  if (!path.isAbsolute(file)) throw invalidConfiguration();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ALIAS_FILE_BYTES) throw invalidConfiguration();
    // Bound the read itself as well, including if the file grows after stat.
    const buffer = Buffer.alloc(MAX_ALIAS_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_ALIAS_FILE_BYTES) throw invalidConfiguration();
    return parseAliases(JSON.parse(buffer.toString("utf8", 0, length))).get(identifier.toUpperCase()) ?? null;
  } catch {
    throw invalidConfiguration();
  } finally {
    await handle?.close();
  }
}
