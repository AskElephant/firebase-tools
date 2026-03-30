import * as path from "path";
import * as fs from "fs-extra";
import * as yaml from "yaml";
import { logger } from "../../../logger";
import { WorkspaceRegistry, getRelativePath, toSafeName } from "./types";

export interface PnpmLockfile {
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
  targetPackageName: string;
}

export interface LockfileImporterSource {
  importerPath: string;
  lockfile: PnpmLockfile;
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
    logger.debug(`Failed to parse pnpm-lock.yaml: ${String(err)}`);
    return null;
  }
}

/**
 *
 */
export function hasAllImporters(lockfile: PnpmLockfile, importerPaths: string[]): boolean {
  if (!lockfile.importers) {
    return false;
  }

  return importerPaths.every((importerPath) => !!lockfile.importers?.[importerPath]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 *
 */
export function mergePackageLockfiles(sources: LockfileImporterSource[]): PnpmLockfile | null {
  if (!sources.length) {
    return null;
  }

  const merged: PnpmLockfile = {
    lockfileVersion: sources[0].lockfile.lockfileVersion,
    importers: {},
  };

  for (const { importerPath, lockfile } of sources) {
    const importer = lockfile.importers?.["."];
    if (!importer) {
      continue;
    }

    if (!merged.importers) {
      merged.importers = {};
    }
    merged.importers[importerPath] = importer;

    if (lockfile.packages) {
      merged.packages = {
        ...(merged.packages ?? {}),
        ...lockfile.packages,
      };
    }

    for (const [key, value] of Object.entries(lockfile)) {
      if (["lockfileVersion", "importers", "packages"].includes(key)) {
        continue;
      }

      const existing = merged[key];
      if (isRecord(existing) && isRecord(value)) {
        merged[key] = {
          ...existing,
          ...value,
        };
      } else if (existing === undefined) {
        merged[key] = value;
      }
    }
  }

  return Object.keys(merged.importers ?? {}).length ? merged : null;
}

function rewriteImporterDependencies(
  deps: Record<string, DependencyEntry> | undefined,
  internalDeps: Set<string>,
  importerOutputDir: string,
  workspacesDir: string,
  targetPackageName: string,
  outputDir: string,
  registry: WorkspaceRegistry,
): Record<string, DependencyEntry> | undefined {
  if (!deps) {
    return deps;
  }

  const result: Record<string, DependencyEntry> = {};
  for (const [depName, depInfo] of Object.entries(deps)) {
    if (depName === targetPackageName && depInfo.specifier?.startsWith("workspace:")) {
      const relativePath = getRelativePath(importerOutputDir, outputDir);
      result[depName] = {
        specifier: `file:${relativePath}`,
        version: `link:${relativePath}`,
      };
    } else if (internalDeps.has(depName)) {
      const depDir = path.join(workspacesDir, toSafeName(depName));
      const relativePath = getRelativePath(importerOutputDir, depDir);
      result[depName] = {
        specifier: `file:${relativePath}`,
        version: `link:${relativePath}`,
      };
    } else if (depInfo.specifier?.startsWith("workspace:") && registry.has(depName)) {
      const pkg = registry.get(depName);
      if (!pkg) {
        result[depName] = depInfo;
        continue;
      }
      const versionSpec = depInfo.specifier.slice("workspace:".length);
      let newSpecifier: string;
      if (versionSpec === "*" || versionSpec === "^" || versionSpec === "~") {
        const prefix = versionSpec === "*" ? "" : versionSpec;
        newSpecifier = `${prefix}${pkg.manifest.version}`;
      } else {
        newSpecifier = versionSpec;
      }
      result[depName] = {
        specifier: newSpecifier,
        version: depInfo.version,
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
        const safeName = toSafeName(depName);
        importerPathToOutputDir.set(
          pkg.rootRelativeDir,
          path.join(rewriteContext.workspacesDir, safeName),
        );
      }
    }
  }

  const importerPathToNewPath = new Map<string, string>();
  if (rewriteContext) {
    importerPathToNewPath.set(targetRelativeDir, ".");
    for (const depName of internalDeps) {
      const pkg = registry.get(depName);
      if (pkg) {
        const safeName = toSafeName(depName);
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
          rewriteContext.targetPackageName,
          rewriteContext.outputDir,
          registry,
        );
        rewrittenImporter.devDependencies = rewriteImporterDependencies(
          importerData.devDependencies,
          internalDeps,
          importerOutputDir,
          rewriteContext.workspacesDir,
          rewriteContext.targetPackageName,
          rewriteContext.outputDir,
          registry,
        );
        rewrittenImporter.optionalDependencies = rewriteImporterDependencies(
          importerData.optionalDependencies,
          internalDeps,
          importerOutputDir,
          rewriteContext.workspacesDir,
          rewriteContext.targetPackageName,
          rewriteContext.outputDir,
          registry,
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
