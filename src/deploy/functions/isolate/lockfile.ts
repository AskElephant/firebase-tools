import * as path from "path";
import * as fs from "fs-extra";
import * as yaml from "yaml";
import { logger } from "../../../logger";
import { WorkspaceRegistry } from "./types";

interface PnpmLockfile {
  lockfileVersion: string | number;
  importers?: Record<string, ImporterData>;
  packages?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DependencyEntry {
  specifier: string;
  version: string;
}

interface ImporterData {
  dependencies?: Record<string, DependencyEntry>;
  devDependencies?: Record<string, DependencyEntry>;
  optionalDependencies?: Record<string, DependencyEntry>;
  [key: string]: unknown;
}

interface RewriteContext {
  outputDir: string;
  workspacesDir: string;
}

function getRelativePath(from: string, to: string): string {
  const relativePath = path.relative(from, to);
  if (!relativePath.startsWith(".")) {
    return `./${relativePath}`;
  }
  return relativePath;
}

/**
 *
 */
export function readPnpmLockfile(workspaceRoot: string): PnpmLockfile | null {
  const lockfilePath = path.join(workspaceRoot, "pnpm-lock.yaml");
  if (!fs.existsSync(lockfilePath)) {
    logger.debug(`No pnpm-lock.yaml found at ${lockfilePath}`);
    return null;
  }

  try {
    const content = fs.readFileSync(lockfilePath, "utf-8");
    return yaml.parse(content) as PnpmLockfile;
  } catch (err) {
    logger.debug(`Failed to parse pnpm-lock.yaml: ${err}`);
    return null;
  }
}

function rewriteImporterDependencies(
  deps: Record<string, DependencyEntry> | undefined,
  internalDeps: Set<string>,
  importerOutputDir: string,
  workspacesDir: string,
): Record<string, DependencyEntry> | undefined {
  if (!deps) {
    return deps;
  }

  const result: Record<string, DependencyEntry> = {};
  for (const [depName, depInfo] of Object.entries(deps)) {
    if (internalDeps.has(depName) && depInfo.specifier?.startsWith("workspace:")) {
      const safeName = depName.replace(/^@/, "").replace(/\//g, "-");
      const depDir = path.join(workspacesDir, safeName);
      const relativePath = getRelativePath(importerOutputDir, depDir);
      result[depName] = {
        specifier: `file:${relativePath}`,
        version: `link:${relativePath}`,
      };
    } else {
      result[depName] = depInfo;
    }
  }
  return result;
}

/**
 *
 */
export function pruneLockfile(
  lockfile: PnpmLockfile,
  targetRelativeDir: string,
  internalDeps: Set<string>,
  registry: WorkspaceRegistry,
  rewriteContext?: RewriteContext,
): PnpmLockfile {
  const pruned: PnpmLockfile = {
    lockfileVersion: lockfile.lockfileVersion,
  };

  if (!lockfile.importers) {
    return { ...lockfile };
  }

  const relevantDirs = new Set<string>([targetRelativeDir]);
  for (const depName of internalDeps) {
    const pkg = registry.get(depName);
    if (pkg) {
      relevantDirs.add(pkg.rootRelativeDir);
    }
  }

  const importerPathToOutputDir = new Map<string, string>();
  if (rewriteContext) {
    importerPathToOutputDir.set(targetRelativeDir, rewriteContext.outputDir);
    for (const depName of internalDeps) {
      const pkg = registry.get(depName);
      if (pkg) {
        const safeName = depName.replace(/^@/, "").replace(/\//g, "-");
        importerPathToOutputDir.set(pkg.rootRelativeDir, path.join(rewriteContext.workspacesDir, safeName));
      }
    }
  }

  const importerPathToNewPath = new Map<string, string>();
  if (rewriteContext) {
    importerPathToNewPath.set(targetRelativeDir, ".");
    for (const depName of internalDeps) {
      const pkg = registry.get(depName);
      if (pkg) {
        const safeName = depName.replace(/^@/, "").replace(/\//g, "-");
        importerPathToNewPath.set(pkg.rootRelativeDir, `workspaces/${safeName}`);
      }
    }
  }

  pruned.importers = {};
  for (const [importerPath, importerData] of Object.entries(lockfile.importers)) {
    if (importerPath === "." && targetRelativeDir !== ".") {
      continue;
    }

    if (relevantDirs.has(importerPath)) {
      const importerOutputDir = importerPathToOutputDir.get(importerPath);
      const newImporterPath = importerPathToNewPath.get(importerPath) ?? importerPath;
      if (rewriteContext && importerOutputDir) {
        const rewrittenImporter: ImporterData = { ...importerData };
        rewrittenImporter.dependencies = rewriteImporterDependencies(
          importerData.dependencies,
          internalDeps,
          importerOutputDir,
          rewriteContext.workspacesDir,
        );
        rewrittenImporter.devDependencies = rewriteImporterDependencies(
          importerData.devDependencies,
          internalDeps,
          importerOutputDir,
          rewriteContext.workspacesDir,
        );
        rewrittenImporter.optionalDependencies = rewriteImporterDependencies(
          importerData.optionalDependencies,
          internalDeps,
          importerOutputDir,
          rewriteContext.workspacesDir,
        );
        pruned.importers[newImporterPath] = rewrittenImporter;
      } else {
        pruned.importers[newImporterPath] = importerData;
      }
    }
  }

  if (lockfile.packages) {
    pruned.packages = lockfile.packages;
  }

  for (const [key, value] of Object.entries(lockfile)) {
    if (!["lockfileVersion", "importers", "packages"].includes(key)) {
      pruned[key] = value;
    }
  }

  return pruned;
}

/**
 *
 */
export function writePrunedLockfile(lockfile: PnpmLockfile, outputPath: string): void {
  const content = yaml.stringify(lockfile, {
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
  });
  fs.writeFileSync(outputPath, content, "utf-8");
  logger.debug(`Wrote pruned lockfile to ${outputPath}`);
}
