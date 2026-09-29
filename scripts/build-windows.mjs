import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as ResEdit from 'resedit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const intermediate = join(root, 'build', 'windows-sea');
const destination = join(root, 'dist', 'YUNTA.exe');
const bundle = join(intermediate, 'stdio.cjs');
const blob = join(intermediate, 'sea.blob');
const config = join(intermediate, 'sea.json');
const icon = join(root, 'assets', 'brand', 'yunta', 'icon.ico');
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

if (process.platform !== 'win32' || process.arch !== 'x64' || !process.versions.node.startsWith('24.')) {
  throw new Error('Windows x64 and Node 24 are required to build YUNTA.exe');
}

await mkdir(intermediate, { recursive: true });
await mkdir(dirname(destination), { recursive: true });
const result = await build({
  entryPoints: [join(root, 'entrypoints', 'mcp', 'sea.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: false,
  metafile: true,
  logLevel: 'warning',
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !dependency.path.startsWith('node:')) {
      throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
    }
  }
}
// esbuild cannot preserve import.meta.url in CJS; the non-SEA branch of the
// audit-path guard must never run in this bundle.
const source = await readFile(bundle, 'utf8');
if (/\b(?:require|import)\s*\(\s*[^'"`]/.test(source)) {
  throw new Error('Nonliteral runtime module load remains in the bundle');
}

await writeFile(config, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: 'none',
}));
function run(args) {
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Build command failed: ${args[0]}`);
}
run(['--experimental-sea-config', config]);
await copyFile(process.execPath, destination);
run([join(root, 'node_modules', 'postject', 'dist', 'cli.js'), destination, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', fuse]);

const binary = await readFile(destination);
// The Node distribution may carry a signature invalidated by SEA injection.
// The edited executable is unsigned; signing, if used, comes last.
const executable = ResEdit.NtExecutable.from(binary, { ignoreCert: true });
const resources = ResEdit.NtExecutableResource.from(executable);
const embeddedBlob = resources.entries.find((entry) => entry.type === 10 && entry.id === 'NODE_SEA_BLOB');
assert.ok(embeddedBlob, 'NODE_SEA_BLOB must exist before editing the icon');
assert.deepEqual(Buffer.from(embeddedBlob.bin), await readFile(blob));
const iconFile = ResEdit.Data.IconFile.from(await readFile(icon));
assert.ok(iconFile.icons.length > 0, 'The ICO must contain at least one image');
const iconGroup = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)[0];
const iconGroupId = iconGroup?.id ?? 101;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries, iconGroupId, 1033, iconFile.icons.map((item) => item.data),
);
resources.outputResource(executable);
await writeFile(destination, Buffer.from(executable.generate()));

const completed = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(await readFile(destination), { ignoreCert: true }));
const completedBlob = completed.entries.find((entry) => entry.type === 10 && entry.id === 'NODE_SEA_BLOB');
assert.ok(completedBlob, 'Icon editing removed the SEA blob');
assert.deepEqual(Buffer.from(completedBlob.bin), await readFile(blob));
const completedGroups = ResEdit.Resource.IconGroupEntry.fromEntries(completed.entries);
assert.ok(completedGroups.length > 0);
assert.equal(completedGroups[0].getIconItemsFromEntries(completed.entries).length, iconFile.icons.length);
console.log(`Built ${destination} with embedded SEA blob and YUNTA icon`);
