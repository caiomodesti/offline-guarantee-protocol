import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const merchantRoot = resolve(repositoryRoot, "apps", "merchant-mobile");
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
      if (specifier !== undefined) pending.push(resolveRelativeModule(current, specifier));
    }
  }
  return visited;
}

describe("merchant production entrypoint isolation", () => {
  it("keeps Sprint 7 public fixture identities unreachable from production", () => {
    const packageJson = JSON.parse(readFileSync(resolve(merchantRoot, "package.json"), "utf8")) as { readonly main?: string };
    expect(packageJson.main).toBe("index.ts");
    const graph = relativeDependencyGraph(resolve(merchantRoot, packageJson.main));
    expect(graph).not.toContain(resolve(merchantRoot, "src", "trust.ts"));
    expect(graph).not.toContain(resolve(merchantRoot, "App.development.tsx"));
    expect(graph).not.toContain(resolve(merchantRoot, "index.development.ts"));
  });

  it("keeps the fixture only in the explicit historical demonstration graph", () => {
    const productionPackage = JSON.parse(readFileSync(resolve(merchantRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const demonstrationPackage = JSON.parse(readFileSync(resolve(merchantRoot, "package.development.json"), "utf8")) as Record<string, unknown>;
    expect({ ...demonstrationPackage, main: productionPackage.main }).toEqual(productionPackage);
    const graph = relativeDependencyGraph(resolve(merchantRoot, "index.development.ts"));
    expect(graph).toContain(resolve(merchantRoot, "src", "trust.ts"));
    expect(graph).toContain(resolve(merchantRoot, "App.development.tsx"));
  });
});
