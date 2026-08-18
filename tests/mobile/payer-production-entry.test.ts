import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const payerRoot = resolve(repositoryRoot, "apps", "payer-mobile");
const extensions = ["", ".ts", ".tsx", ".js", ".jsx"];

function resolveRelativeModule(importer: string, specifier: string): string {
  const base = resolve(dirname(importer), specifier);
  const sourceBases = /\.[cm]?js$/.test(base) ? [base, base.replace(/\.[cm]?js$/, "")] : [base];
  for (const sourceBase of sourceBases) {
    for (const extension of extensions) {
      const candidate = `${sourceBase}${extension}`;
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // Try the next canonical source extension.
      }
    }
  }
  throw new Error(`módulo relativo não encontrado: ${specifier} importado por ${importer}`);
}

function relativeDependencyGraph(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [entry];
  const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(current, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      pending.push(resolveRelativeModule(current, specifier));
    }
  }
  return visited;
}

describe("payer production entrypoint isolation", () => {
  it("keeps the embedded Sprint 7 fixture unreachable from the production graph", () => {
    const packageJson = JSON.parse(readFileSync(resolve(payerRoot, "package.json"), "utf8")) as { readonly main?: string };
    expect(packageJson.main).toBe("index.ts");

    const graph = relativeDependencyGraph(resolve(payerRoot, packageJson.main));
    expect(graph).not.toContain(resolve(payerRoot, "src", "dev-session.ts"));
    expect(graph).not.toContain(resolve(payerRoot, "App.development.tsx"));
    expect(graph).not.toContain(resolve(payerRoot, "index.development.ts"));
    expect(graph).not.toContain(resolve(payerRoot, "src", "h0-lifecycle-probe.ts"));
    expect(graph).not.toContain(resolve(payerRoot, "App.h0.tsx"));
    expect(graph).not.toContain(resolve(payerRoot, "index.h0.ts"));
  });

  it("keeps the fixture reachable only from the explicit demonstration graph", () => {
    const productionPackage = JSON.parse(readFileSync(resolve(payerRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const demonstrationPackage = JSON.parse(readFileSync(resolve(payerRoot, "package.development.json"), "utf8")) as Record<string, unknown>;
    expect({ ...demonstrationPackage, main: productionPackage.main }).toEqual(productionPackage);

    const graph = relativeDependencyGraph(resolve(payerRoot, "index.development.ts"));
    expect(graph).toContain(resolve(payerRoot, "src", "dev-session.ts"));
    expect(graph).toContain(resolve(payerRoot, "App.development.tsx"));
  });

  it("keeps H0 fixture material reachable only from the isolated H0 graph", () => {
    const productionPackage = JSON.parse(readFileSync(resolve(payerRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const h0Package = JSON.parse(readFileSync(resolve(payerRoot, "package.h0.json"), "utf8")) as Record<string, unknown>;
    expect({ ...h0Package, main: productionPackage.main }).toEqual(productionPackage);

    const graph = relativeDependencyGraph(resolve(payerRoot, "index.h0.ts"));
    expect(graph).toContain(resolve(payerRoot, "src", "h0-lifecycle-probe.ts"));
    expect(graph).toContain(resolve(payerRoot, "src", "dev-session.ts"));
    expect(graph).toContain(resolve(payerRoot, "App.h0.tsx"));
  });
});
