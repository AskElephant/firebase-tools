import * as path from "path";
import * as fs from "fs-extra";
import { PackageManifest, WorkspaceRegistry, getRelativePath, toSafeName } from "./types";

/**
 *
 */
interface RewriteOptions {
  manifestDir: string;
  workspacesDir: string;
  outputDir: string;
  targetPackageName: string;
}

export function rewriteWorkspaceDependencies(
  manifest: PackageManifest,
  registry: WorkspaceRegistry,
  internalDeps: Set<string>,
  options: RewriteOptions,
): PackageManifest {
  const { manifestDir, workspacesDir, outputDir, targetPackageName } = options;
  const rewritten = { ...manifest };

  const rewriteDeps = (
    deps: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!deps) {
      return deps;
    }

    const result: Record<string, string> = {};
    for (const [depName, depVersion] of Object.entries(deps)) {
      if (depName === targetPackageName && depVersion.startsWith("workspace:")) {
        const relativePath = getRelativePath(manifestDir, outputDir);
        result[depName] = `file:${relativePath}`;
      } else if (internalDeps.has(depName) && registry.has(depName)) {
        const depDir = path.join(workspacesDir, toSafeName(depName));
        const relativePath = getRelativePath(manifestDir, depDir);
        result[depName] = `file:${relativePath}`;
      } else if (depVersion.startsWith("workspace:") && registry.has(depName)) {
        const pkg = registry.get(depName)!;
        const versionSpec = depVersion.slice("workspace:".length);
        if (versionSpec === "*" || versionSpec === "^" || versionSpec === "~") {
          const prefix = versionSpec === "*" ? "" : versionSpec;
          result[depName] = `${prefix}${pkg.manifest.version}`;
        } else {
          result[depName] = versionSpec;
        }
      } else {
        result[depName] = depVersion;
      }
    }
    return result;
  };

  if (rewritten.dependencies) {
    rewritten.dependencies = rewriteDeps(rewritten.dependencies);
  }

  if (rewritten.devDependencies) {
    rewritten.devDependencies = rewriteDeps(rewritten.devDependencies);
  }

  if (rewritten.optionalDependencies) {
    rewritten.optionalDependencies = rewriteDeps(rewritten.optionalDependencies);
  }

  return rewritten;
}

/**
 *
 */
export function writeAdaptedManifest(manifest: PackageManifest, outputPath: string): void {
  fs.writeJsonSync(outputPath, manifest, { spaces: 2 });
}
