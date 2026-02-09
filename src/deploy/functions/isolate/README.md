# Workspace Isolation for Firebase Functions

This module provides functionality to isolate a Firebase Functions package from a pnpm monorepo workspace, creating a standalone deployable bundle that includes all internal workspace dependencies.

## Purpose

When deploying Firebase Functions from a pnpm monorepo, the deployment process needs access to internal workspace dependencies that are normally resolved via pnpm's workspace protocol (`workspace:*`). This module:

1. Identifies all internal workspace dependencies (transitively)
2. Packs and extracts each dependency into a `workspaces/` subdirectory
3. Rewrites `package.json` manifests to use `file:` references instead of `workspace:` protocols
4. Prunes and rewrites `pnpm-lock.yaml` to only include relevant importers
5. Creates a minimal `pnpm-workspace.yaml` for the isolated output

## Usage

```typescript
import { isolateWorkspace } from "./isolate";

const result = await isolateWorkspace({
  projectDir: "/path/to/monorepo",
  sourceDir: "/path/to/monorepo/packages/functions",
  outputDir: "/path/to/monorepo/packages/functions/_isolated_",
  includeDevDependencies: false,
});

console.log(result.isolatedDir); // Path to isolated output
console.log(result.packagesIncluded); // List of included packages
```

## Options

| Option | Type | Description |
|--------|------|-------------|
| `projectDir` | `string` | Root directory of the Firebase project |
| `sourceDir` | `string` | Directory of the functions package to isolate |
| `outputDir` | `string` | Destination for the isolated output |
| `includeDevDependencies` | `boolean` | Whether to include devDependencies of the target package |

## Output Structure

```
_isolated_/
├── package.json          # Rewritten with file: references
├── pnpm-lock.yaml        # Pruned lockfile
├── pnpm-workspace.yaml   # Minimal workspace config
├── lib/                  # Your functions code
├── workspaces/
│   ├── shared-utils/     # Packed internal dependency
│   └── common__types/    # Scoped package (@common/types)
└── ...
```

## Module Files

- `isolate.ts` - Main entry point and orchestration
- `registry.ts` - Workspace package discovery and dependency resolution
- `manifest.ts` - package.json rewriting logic
- `lockfile.ts` - pnpm-lock.yaml pruning and rewriting
- `pack.ts` - Package packing and extraction
- `types.ts` - Shared type definitions and utilities

## Safe Name Conversion

Scoped packages like `@scope/name` are converted to `scope__name` to avoid filesystem collisions with unscoped packages like `scope-name`.
