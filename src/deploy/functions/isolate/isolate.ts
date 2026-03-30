import * as path from "path";
import * as fs from "fs-extra";
import { FirebaseError } from "../../../error";
import { logger } from "../../../logger";
import { logLabeledBullet } from "../../../utils";
import {
  IsolateOptions,
  IsolateResult,
  PackageManifest,
  WorkspacePackage,
  WorkspaceRegistry,
  toSafeName,
} from "./types";
import {
  findWorkspaceRoot,
  buildWorkspaceRegistry,
  findInternalDependencies,
  getPackageFromDir,
} from "./registry";
import { packAndExtract } from "./pack";
import { rewriteWorkspaceDependencies, writeAdaptedManifest } from "./manifest";
import {
  hasAllImporters,
  LockfileImporterSource,
  mergePackageLockfiles,
  PnpmLockfile,
  readPnpmLockfile,
  pruneLockfile,
  writePrunedLockfile,
} from "./lockfile";

function getRelevantImporterPaths(
  targetPackage: WorkspacePackage,
  internalDeps: Set<string>,
  registry: WorkspaceRegistry,
): string[] {
  const importerPaths: string[] = [targetPackage.rootRelativeDir];

  for (const depName of internalDeps) {
    const depPackage = registry.get(depName);
    if (depPackage) {
      importerPaths.push(depPackage.rootRelativeDir);
    }
  }

  return importerPaths;
}

/**
 *
 */
function resolveLockfileForIsolation(
  workspaceRoot: string,
  targetPackage: WorkspacePackage,
  internalDeps: Set<string>,
  registry: WorkspaceRegistry,
): ReturnType<typeof readPnpmLockfile> {
  const importerPaths = getRelevantImporterPaths(targetPackage, internalDeps, registry);
  const workspaceLockfile = readPnpmLockfile(workspaceRoot);

  if (workspaceLockfile && hasAllImporters(workspaceLockfile, importerPaths)) {
    return workspaceLockfile;
  }

  if (workspaceLockfile) {
    logger.debug(
      `Workspace pnpm-lock.yaml is missing relevant importers (${importerPaths.join(", ")}), ` +
        "falling back to package-local lockfiles",
    );
  }

  const packageLockfiles: LockfileImporterSource[] = [];
  const targetLockfile = readPnpmLockfile(targetPackage.absoluteDir);
  if (!targetLockfile) {
    logger.debug(`No package-local pnpm-lock.yaml found for ${targetPackage.name}`);
    return workspaceLockfile;
  }
  packageLockfiles.push({
    importerPath: targetPackage.rootRelativeDir,
    lockfile: targetLockfile,
  });

  for (const depName of internalDeps) {
    const depPackage = registry.get(depName);
    if (!depPackage) {
      continue;
    }

    const depLockfile = readPnpmLockfile(depPackage.absoluteDir);
    if (!depLockfile) {
      logger.debug(`No package-local pnpm-lock.yaml found for ${depPackage.name}`);
      continue;
    }

    packageLockfiles.push({
      importerPath: depPackage.rootRelativeDir,
      lockfile: depLockfile,
    });
  }

  if (packageLockfiles.length !== importerPaths.length) {
    logger.debug(
      `Only found ${packageLockfiles.length} package-local pnpm lockfile(s) for ` +
        `${importerPaths.length} relevant importer(s)`,
    );
  }

  return mergePackageLockfiles(packageLockfiles) ?? workspaceLockfile;
}

function hasNodeModulesSegment(rootDir: string, filePath: string): boolean {
  const relativePath = path.relative(rootDir, filePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  const segments = relativePath.split(path.sep);
  return segments.includes("node_modules");
}

function copyPackageSource(sourceDir: string, destDir: string): void {
  fs.ensureDirSync(destDir);

  const outputDirName = path.basename(destDir);
  const items = fs.readdirSync(sourceDir);
  for (const item of items) {
    if (item === "node_modules" || item === outputDirName) {
      continue;
    }

    const srcPath = path.join(sourceDir, item);
    const destPath = path.join(destDir, item);

    fs.copySync(srcPath, destPath, {
      filter: (src) => !hasNodeModulesSegment(sourceDir, src),
    });
  }
}

function writePnpmWorkspaceYaml(outputDir: string): void {
  const content = `packages:\n  - "workspaces/*"\n`;
  fs.writeFileSync(path.join(outputDir, "pnpm-workspace.yaml"), content, "utf-8");
}

function readPackageManifest(manifestPath: string): PackageManifest {
  return fs.readJsonSync(manifestPath) as PackageManifest;
}

function getPatchedDependencies(manifest: PackageManifest): Record<string, string> | undefined {
  const pnpmConfig = manifest["pnpm"];
  if (!pnpmConfig || typeof pnpmConfig !== "object" || Array.isArray(pnpmConfig)) {
    return undefined;
  }

  const patchedDependencies = (pnpmConfig as Record<string, unknown>)["patchedDependencies"];
  if (
    !patchedDependencies ||
    typeof patchedDependencies !== "object" ||
    Array.isArray(patchedDependencies)
  ) {
    return undefined;
  }

  return patchedDependencies as Record<string, string>;
}

function alignLockfileWithManifest(lockfile: PnpmLockfile, manifest: PackageManifest): void {
  if (!getPatchedDependencies(manifest)) {
    delete lockfile.patchedDependencies;
  }
}

/**
 *
 */
function validateOutputDir(sourceDir: string, outputDir: string): void {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedOutput = path.resolve(outputDir);

  if (resolvedSource === resolvedOutput) {
    throw new FirebaseError(
      `Output directory cannot be the same as source directory: ${resolvedOutput}`,
    );
  }

  if (resolvedSource.startsWith(resolvedOutput + path.sep)) {
    throw new FirebaseError(
      `Output directory cannot be a parent of source directory: ${resolvedOutput}`,
    );
  }
}

/**
 *
 */
export async function isolateWorkspace(options: IsolateOptions): Promise<IsolateResult> {
  const { sourceDir, outputDir, includeDevDependencies } = options;

  logLabeledBullet("functions", "isolating workspace dependencies...");

  validateOutputDir(sourceDir, outputDir);

  const workspaceRoot = findWorkspaceRoot(sourceDir);
  if (!workspaceRoot) {
    throw new FirebaseError(
      "Could not find pnpm-workspace.yaml. Workspace isolation requires a pnpm monorepo.",
    );
  }

  logger.debug(`Found workspace root at ${workspaceRoot}`);

  const registry: WorkspaceRegistry = buildWorkspaceRegistry(workspaceRoot);
  logger.debug(`Built workspace registry with ${registry.size} packages`);

  const targetPackage = getPackageFromDir(sourceDir, registry);
  logger.debug(`Target package: ${targetPackage.name}`);

  const internalDeps = findInternalDependencies(
    targetPackage.name,
    registry,
    includeDevDependencies,
  );
  logger.debug(`Found ${internalDeps.size} internal dependencies: ${[...internalDeps].join(", ")}`);

  if (fs.existsSync(outputDir)) {
    fs.removeSync(outputDir);
  }
  fs.ensureDirSync(outputDir);

  copyPackageSource(sourceDir, outputDir);
  logger.debug(`Copied source to ${outputDir}`);

  const workspacesDir = path.join(outputDir, "workspaces");
  const packagesIncluded: string[] = [targetPackage.name];

  if (internalDeps.size > 0) {
    fs.ensureDirSync(workspacesDir);

    for (const depName of internalDeps) {
      const depPackage = registry.get(depName);
      if (!depPackage) {
        continue;
      }

      await packAndExtract(depPackage, workspacesDir);
      packagesIncluded.push(depName);

      const depDir = path.join(workspacesDir, toSafeName(depName));
      const depManifestPath = path.join(depDir, "package.json");

      if (fs.existsSync(depManifestPath)) {
        const depManifest = readPackageManifest(depManifestPath);
        const rewrittenDepManifest = rewriteWorkspaceDependencies(
          depManifest,
          registry,
          internalDeps,
          {
            manifestDir: depDir,
            workspacesDir,
            outputDir,
            targetPackageName: targetPackage.name,
          },
        );
        writeAdaptedManifest(rewrittenDepManifest, depManifestPath);
      }
    }
  }

  const targetManifestPath = path.join(outputDir, "package.json");
  let rewrittenTargetManifest: PackageManifest | undefined;
  if (fs.existsSync(targetManifestPath)) {
    const targetManifest = readPackageManifest(targetManifestPath);
    rewrittenTargetManifest = rewriteWorkspaceDependencies(targetManifest, registry, internalDeps, {
      manifestDir: outputDir,
      workspacesDir,
      outputDir,
      targetPackageName: targetPackage.name,
    });
    writeAdaptedManifest(rewrittenTargetManifest, targetManifestPath);
  }

  const lockfile = resolveLockfileForIsolation(
    workspaceRoot,
    targetPackage,
    internalDeps,
    registry,
  );
  if (lockfile) {
    const prunedLockfile = pruneLockfile(
      lockfile,
      targetPackage.rootRelativeDir,
      internalDeps,
      registry,
      { outputDir, workspacesDir, targetPackageName: targetPackage.name },
    );
    if (rewrittenTargetManifest) {
      alignLockfileWithManifest(prunedLockfile, rewrittenTargetManifest);
    }
    writePrunedLockfile(prunedLockfile, path.join(outputDir, "pnpm-lock.yaml"));
  } else {
    logger.debug("No lockfile found, skipping lockfile pruning");
  }

  if (internalDeps.size > 0) {
    writePnpmWorkspaceYaml(outputDir);
  }

  logLabeledBullet(
    "functions",
    `isolated ${packagesIncluded.length} package(s) to ${path.relative(options.projectDir, outputDir)}`,
  );

  return {
    isolatedDir: outputDir,
    packagesIncluded,
  };
}
