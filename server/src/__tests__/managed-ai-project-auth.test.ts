import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertManagedAiProjectAuth } from "../services/ai-connection-runtime.js";

describe("managed AI project authentication", () => {
  let home: string;
  let project: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-project-auth-"));
    project = path.join(home, "work", "project");
    await mkdir(project, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function configAt(directory: string, relative: string, content: string) {
    const destination = path.join(directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  it("ignores host Codex authentication settings that isolated runs do not inherit", async () => {
    await configAt(home, ".codex/config.toml", 'model_provider = "host-provider"\ncli_auth_credentials_store = "keyring"');
    await expect(assertManagedAiProjectAuth({ cwd: project }, "openai")).resolves.toBeUndefined();
    await expect(assertManagedAiProjectAuth({ cwd: home }, "openai")).resolves.toBeUndefined();
  });

  it.each(["project", "parent"])("still rejects Codex overrides in the %s directory", async (location) => {
    await configAt(location === "project" ? project : path.dirname(project), ".codex/config.toml", 'env_key = "PROJECT_TOKEN"');
    await expect(assertManagedAiProjectAuth({ cwd: project }, "openai")).rejects.toThrow("Project authentication settings conflict");
  });

  it("still checks host Claude settings because the Codex exception is provider-specific", async () => {
    await configAt(home, ".claude/settings.json", '{"apiKeyHelper":"host-helper"}');
    await expect(assertManagedAiProjectAuth({ cwd: project }, "anthropic")).rejects.toThrow("Project authentication settings conflict");
  });

  it("does not relax explicit authentication arguments", async () => {
    await expect(assertManagedAiProjectAuth({ cwd: project, args: ["--config=host"] }, "openai")).rejects.toThrow("Remove authentication/configuration overrides");
  });
});
