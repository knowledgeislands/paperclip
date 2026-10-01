import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue identifier route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue identifier routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-identifier-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        // cloud_tenant actors are never instance admins — access flows through
        // company-scoped membership grants, seeded per test company below.
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCloudTenantMember(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  it("resolves alphanumeric Cloud tenant issue identifiers for detail reads and updates", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cloud tenant",
      issuePrefix: "PC1A2",
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 7,
      identifier: "PC1A2-7",
      title: "Tenant identifier route",
      status: "todo",
      priority: "medium",
      createdByUserId: "cloud-user-1",
    });

    const app = createApp(companyId);
    const read = await request(app).get("/api/issues/pc1a2-7");

    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
    });

    const updated = await request(app)
      .patch("/api/issues/PC1A2-7")
      .send({ priority: "high" });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      id: issueId,
      companyId,
      identifier: "PC1A2-7",
      priority: "high",
    });

    const stored = await db
      .select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(stored?.priority).toBe("high");
  });

  it("resolves historical aliases without bypassing company, issue-number or route access checks", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Renamed fixture", issuePrefix: "REN" },
      { id: otherCompanyId, name: "Other renamed fixture", issuePrefix: "OTH" },
    ]);
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "REN-17", issueNumber: 17, title: "Historical fixture" },
      { id: otherIssueId, companyId: otherCompanyId, identifier: "OTH-17", issueNumber: 17, title: "Other historical fixture" },
    ]);
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-alias-routes-"));
    const file = path.join(directory, "aliases.json");
    try {
      await writeFile(file, JSON.stringify({ aliases: [
        { legacy: "OLD-17", id: issueId, companyId },
        { legacy: "BAD-17", id: issueId, companyId: otherCompanyId },
        { legacy: "OLD-18", id: issueId, companyId },
        { legacy: "EXT-17", id: otherIssueId, companyId: otherCompanyId },
      ] }));
      vi.stubEnv("PAPERCLIP_ISSUE_ALIASES_FILE", file);
      const app = createApp(companyId);
      const found = await request(app).get("/api/issues/old-17");
      expect(found.status, JSON.stringify(found.body)).toBe(200);
      expect(found.body).toMatchObject({ id: issueId, identifier: "REN-17", companyId });
      expect((await request(app).get("/api/issues/BAD-17")).status).toBe(404);
      expect((await request(app).get("/api/issues/OLD-18")).status).toBe(404);
      // Company-inaccessible resources use the ordinary not-found response.
      expect((await request(app).get("/api/issues/EXT-17")).status).toBe(404);
      expect((await request(app).get("/api/issues/OTH-17")).status).toBe(404);
      const updated = await request(app).patch("/api/issues/OLD-17").send({ priority: "high" });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(updated.body).toMatchObject({ id: issueId, priority: "high" });
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps current identifiers authoritative even when a conflicting snapshot is invalid", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Current fixture", issuePrefix: "CUR" });
    await seedCloudTenantMember(companyId);
    await db.insert(issues).values({ id: issueId, companyId, identifier: "CUR-8", issueNumber: 8, title: "Current fixture" });
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-current-routes-"));
    const file = path.join(directory, "aliases.json");
    try {
      await writeFile(file, JSON.stringify({ aliases: [
        { legacy: "CUR-8", id: randomUUID(), companyId: randomUUID() },
      ] }));
      vi.stubEnv("PAPERCLIP_ISSUE_ALIASES_FILE", file);
      const app = createApp(companyId);
      const current = await request(app).get("/api/issues/CUR-8");
      expect(current.status, JSON.stringify(current.body)).toBe(200);
      expect(current.body).toMatchObject({ id: issueId });
      await writeFile(file, "malformed private snapshot");
      expect((await request(app).get("/api/issues/CUR-8")).status).toBe(200);
      const invalidFallback = await request(app).get("/api/issues/OLD-8");
      expect(invalidFallback.status).toBe(422);
      expect(JSON.stringify(invalidFallback.body)).not.toContain(file);
      expect(JSON.stringify(invalidFallback.body)).not.toContain("malformed private snapshot");
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
