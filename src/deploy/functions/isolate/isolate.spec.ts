import { expect } from "chai";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";
import * as yaml from "yaml";
import * as pack from "./pack";
import { isolateWorkspace } from "./isolate";
import { toSafeName } from "./types";

describe("isolateWorkspace", () => {
  let tempDir: string;
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firebase-tools-isolate-"));
  });

  afterEach(() => {
    sandbox.restore();
    fs.removeSync(tempDir);
  });

  it("builds an isolated lockfile from package-local pnpm lockfiles", async () => {
    fs.writeFileSync(
      path.join(tempDir, "pnpm-workspace.yaml"),
      `packages:
  - "apps/*"
  - "packages/*"
sharedWorkspaceLockfile: false
`,
    );

    fs.writeFileSync(
      path.join(tempDir, "pnpm-lock.yaml"),
      `lockfileVersion: "9.0"
importers:
  .:
    dependencies: {}
packages: {}
`,
    );

    const functionsDir = path.join(tempDir, "apps", "functions");
    fs.ensureDirSync(functionsDir);
    fs.writeJsonSync(path.join(functionsDir, "package.json"), {
      name: "@scope/functions",
      version: "1.0.0",
      files: ["index.js"],
      dependencies: {
        "@scope/logging-be": "workspace:*",
        openai: "^6.17.0",
      },
    });
    fs.writeFileSync(path.join(functionsDir, "index.js"), "export const handler = () => null;\n");
    fs.writeFileSync(
      path.join(functionsDir, "pnpm-lock.yaml"),
      `lockfileVersion: "9.0"
importers:
  .:
    dependencies:
      "@scope/logging-be":
        specifier: "workspace:*"
        version: "link:../../packages/logging-be"
      openai:
        specifier: "^6.17.0"
        version: "6.17.0"
packages:
  "openai@6.17.0":
    resolution:
      integrity: "sha512-openai"
`,
    );

    const loggingDir = path.join(tempDir, "packages", "logging-be");
    fs.ensureDirSync(loggingDir);
    fs.writeJsonSync(path.join(loggingDir, "package.json"), {
      name: "@scope/logging-be",
      version: "0.1.0",
      files: ["index.js"],
      dependencies: {
        "serialize-error": "^11.0.3",
      },
    });
    fs.writeFileSync(path.join(loggingDir, "index.js"), "export const logger = () => null;\n");
    fs.writeFileSync(
      path.join(loggingDir, "pnpm-lock.yaml"),
      `lockfileVersion: "9.0"
importers:
  .:
    dependencies:
      serialize-error:
        specifier: "^11.0.3"
        version: "11.0.3"
packages:
  "serialize-error@11.0.3":
    resolution:
      integrity: "sha512-serialize-error"
`,
    );

    sandbox.stub(pack, "packAndExtract").callsFake(async (pkg, workspacesDir) => {
      const destDir = path.join(workspacesDir, toSafeName(pkg.name));
      fs.copySync(pkg.absoluteDir, destDir);
      return destDir;
    });

    const outputDir = path.join(tempDir, "apps", "functions", "_isolated_");
    await isolateWorkspace({
      projectDir: tempDir,
      sourceDir: functionsDir,
      outputDir,
      includeDevDependencies: false,
    });

    const lockfile = yaml.parse(
      fs.readFileSync(path.join(outputDir, "pnpm-lock.yaml"), "utf8"),
    ) as {
      patchedDependencies?: Record<string, string>;
      importers?: Record<
        string,
        {
          dependencies?: Record<string, { specifier: string; version: string }>;
        }
      >;
    };

    expect(lockfile.importers).to.have.keys(".", "workspaces/scope__logging-be");
    expect(lockfile.patchedDependencies).to.equal(undefined);
    expect(lockfile.importers?.["."]?.dependencies?.["openai"]?.version).to.equal("6.17.0");
    expect(lockfile.importers?.["."]?.dependencies?.["@scope/logging-be"]).to.deep.equal({
      specifier: "file:./workspaces/scope__logging-be",
      version: "link:./workspaces/scope__logging-be",
    });
    expect(
      lockfile.importers?.["workspaces/scope__logging-be"]?.dependencies?.["serialize-error"]
        ?.version,
    ).to.equal("11.0.3");
  });
});
