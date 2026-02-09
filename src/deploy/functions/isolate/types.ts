export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  name: string;
  absoluteDir: string;
  rootRelativeDir: string;
  manifest: PackageManifest;
}

export type WorkspaceRegistry = Map<string, WorkspacePackage>;

export interface IsolateOptions {
  projectDir: string;
  sourceDir: string;
  outputDir: string;
  includeDevDependencies: boolean;
}

export interface IsolateResult {
  isolatedDir: string;
  packagesIncluded: string[];
}

export function getRelativePath(from: string, to: string): string {
  const path = require("path");
  const relativePath = path.relative(from, to);
  if (!relativePath.startsWith(".")) {
    return `./${relativePath}`;
  }
  return relativePath;
}

export function toSafeName(name: string): string {
  if (name.startsWith("@")) {
    const withoutAt = name.slice(1);
    const [scope, pkg] = withoutAt.split("/");
    return `${scope}__${pkg}`;
  }
  return name;
}
