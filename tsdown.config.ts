import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

/**
 * Inject __OPENCLAW_VERSION__ at build time so `src/version.ts` can resolve the
 * correct version string without relying on runtime package.json resolution.
 *
 * When OPENCLAW_VERSION_TAG is set (e.g. by a custom build script), the version
 * is augmented with that tag as build metadata: `<version>+<tag>`.
 * Otherwise, the plain package.json version is used.
 *
 * Fixes: https://github.com/openclaw/openclaw/issues/8912
 */
function buildDefine(): Record<string, string> {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const versionTag = process.env.OPENCLAW_VERSION_TAG;
  const version = versionTag ? `${pkg.version}+${versionTag}` : pkg.version;
  return {
    __OPENCLAW_VERSION__: JSON.stringify(version),
  };
}

const define = buildDefine();

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/entry.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    // Ensure this module is bundled as an entry so legacy CLI shims can resolve its exports.
    entry: "src/cli/daemon-cli.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/plugin-sdk/account-id.ts",
    outDir: "dist/plugin-sdk",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: ["src/hooks/bundled/*/handler.ts", "src/hooks/llm-slug-generator.ts"],
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
]);
