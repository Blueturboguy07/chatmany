// A source guard, not a behaviour test.
//
// src/db.ts is the SELF-HOST accessor: every one of its functions is bound to the reserved tenant
// id 'self'. If a hosted module ever imported one of them it would compile, run, and quietly read
// or write the wrong tenant's rows. Hosted code may only reach data through TenantDb, so the
// hosted modules are not allowed to import src/db at all.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HOSTED_FILES = [
  "src/tenant/runner.ts",
  "src/tenant/do.ts",
  "src/tenant/registry.ts",
  "src/tenant/metering.ts",
  "src/routes/hosted.ts",
];

describe("hosted code never touches the self-host accessor", () => {
  for (const file of HOSTED_FILES) {
    it(`${file} imports no function from src/db`, () => {
      const url = new URL(`../${file}`, import.meta.url);
      const src = readFileSync(url, "utf8");
      const imports = [...src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]!);
      // Resolve each relative import against the importing file, so "./db" inside src/tenant is
      // recognised as TenantDb and not as the self-host accessor.
      const offending = imports
        .filter((p) => p.startsWith("."))
        .map((p) => new URL(p, url).pathname)
        .filter((p) => p.endsWith("/src/db"));
      expect(offending).toEqual([]);
    });
  }

  it("every statement in TenantDb names tenant_id", () => {
    const src = readFileSync(new URL("../src/tenant/db.ts", import.meta.url), "utf8");
    const statements = [...src.matchAll(/\.prepare\(\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]!);
    expect(statements.length).toBeGreaterThan(20);
    const tables = /\b(campaigns|conversations|processed_comments|comment_actions|send_claims|kv|events|usage_monthly)\b/;
    for (const sql of statements) {
      if (!tables.test(sql)) continue;
      expect(sql, `statement without tenant_id: ${sql}`).toContain("tenant_id");
    }
  });

  it("no migration leaves a table without tenant_id", () => {
    const dir = new URL("../schema/", import.meta.url);
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(new URL(f, dir), "utf8"))
      .join("\n");
    // Tables that exist after every migration has been applied, and must carry tenant_id.
    for (const table of ["conversations", "processed_comments", "comment_actions", "send_claims", "kv", "campaigns", "events"]) {
      const create = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}_new \\(([\\s\\S]*?)\\);`, "i").exec(sql);
      expect(create, `${table} is never rebuilt with tenant_id`).not.toBeNull();
      expect(create![1]).toContain("tenant_id");
    }
  });
});
