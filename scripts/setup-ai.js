import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'vendor', 'pikafish');
const cache = path.join(root, '.cache', 'pikafish');
const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));

async function matches(filename, expected) {
  try {
    if ((await stat(filename)).size !== expected.bytes) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex') === expected.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function command(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (exit ${result.status}).`);
}

async function download(expected) {
  const filename = path.join(cache, expected.name);
  if (await matches(filename, expected)) return filename;
  const partial = `${filename}.download-${process.pid}`;
  console.log(`Downloading ${expected.name} from ${expected.url}`);
  try {
    command('curl.exe', [
      '--fail', '--location', '--retry', '2', '--connect-timeout', '20',
      '--max-time', '600', '--output', partial, expected.url,
    ]);
    if (!(await matches(partial, expected))) {
      throw new Error(`Size or SHA-256 mismatch: ${expected.name}; refusing to install.`);
    }
    await rename(partial, filename);
    return filename;
  } finally {
    await rm(partial, { force: true });
  }
}

async function prepare() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This pinned Pikafish package targets Windows x64. Run setup:ai on Windows x64.');
  }
  await mkdir(cache, { recursive: true });
  const missing = [];
  for (const entry of manifest.files) {
    if (!(await matches(path.join(destination, entry.path), entry))) missing.push(entry);
  }
  if (missing.length) {
    const archive = await download(manifest.archive);
    const staging = await mkdtemp(path.join(cache, 'extract-'));
    try {
      // Windows 10/11 tar (libarchive) reads 7z. Extract only the pinned resources.
      command('tar.exe', ['-xf', archive, '-C', staging, ...missing.map((entry) => entry.archivePath)]);
      for (const entry of missing) {
        const extracted = path.join(staging, entry.archivePath);
        if (!(await matches(extracted, entry))) {
          throw new Error(`Size or SHA-256 mismatch after extraction: ${entry.archivePath}`);
        }
      }
      for (const entry of missing) {
        await copyFile(path.join(staging, entry.archivePath), path.join(destination, entry.path));
      }
    } finally {
      // staging is an absolute mkdtemp path under this project's .cache/pikafish.
      const relative = path.relative(cache, staging);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('extract-')) {
        throw new Error('Refusing to remove an unexpected staging directory.');
      }
      await rm(staging, { recursive: true, force: true });
    }
  }
  const sourcePath = path.join(destination, manifest.source.name);
  if (!(await matches(sourcePath, manifest.source))) {
    await copyFile(await download(manifest.source), sourcePath);
  }
  // Recheck the files actually used for development and packaging.
  for (const entry of manifest.files) {
    if (!(await matches(path.join(destination, entry.path), entry))) {
      throw new Error(`Installed resource verification failed: ${entry.path}`);
    }
  }
  if (!(await matches(sourcePath, manifest.source))) throw new Error('Source archive verification failed.');
  const bytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, manifest.source.bytes);
  console.log(`${manifest.release}: resources verified (${bytes.toLocaleString('en-US')} bytes plus manifest and notes).`);
  console.log('Pikafish is ready for local, offline play. Weights: no commercial use without permission.');
}

prepare().catch((error) => {
  console.error(`Pikafish setup failed: ${error.message}`);
  process.exitCode = 1;
});
