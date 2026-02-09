import * as path from "path";
import * as fs from "fs-extra";
import { FirebaseError } from "../../../error";
import { logger } from "../../../logger";
import { logLabeledBullet } from "../../../utils";
import { IsolateOptions, IsolateResult, WorkspaceRegistry, toSafeName } from "./types";
import {
  findWorkspaceRoot,
  buildWorkspaceRegistry,
  findInternalDependencies,
  getPackageFromDir,
} from "./registry";
import { packAndExtract } from "./pack";
import { rewriteWorkspaceDependencies, writeAdaptedManifest } from "./manifest";
import { readPnpmLockfile, pruneLockfile, writePrunedLockfile } from "./lockfile";

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
        const depManifest = fs.readJsonSync(depManifestPath);
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
  if (fs.existsSync(targetManifestPath)) {
    const targetManifest = fs.readJsonSync(targetManifestPath);
    const rewrittenManifest = rewriteWorkspaceDependencies(targetManifest, registry, internalDeps, {
      manifestDir: outputDir,
      workspacesDir,
      outputDir,
      targetPackageName: targetPackage.name,
    });
    writeAdaptedManifest(rewrittenManifest, targetManifestPath);
  }

  const lockfile = readPnpmLockfile(workspaceRoot);
  if (lockfile) {
    const prunedLockfile = pruneLockfile(
      lockfile,
      targetPackage.rootRelativeDir,
      internalDeps,
      registry,
      { outputDir, workspacesDir, targetPackageName: targetPackage.name },
    );
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
