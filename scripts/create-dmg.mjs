import { access, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pkg from '../package.json' with { type: 'json' };

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const distDir = path.join(appRoot, 'dist');
const productName = pkg.build?.productName || 'PR Monitor';
const safeProductName = productName.replace(/\s+/g, '-');

async function exists(candidate) {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveAppBundle() {
  const arch = process.env.npm_config_arch || process.arch;
  const candidates = [
    path.join(distDir, `mac-${arch}`, `${productName}.app`),
    path.join(distDir, 'mac-arm64', `${productName}.app`),
    path.join(distDir, 'mac', `${productName}.app`)
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  throw new Error(`Could not find ${productName}.app under ${distDir}. Run npm run desktop:dir first.`);
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('create-dmg.mjs uses hdiutil and must run on macOS.');
  }

  const appBundle = await resolveAppBundle();
  const arch = path.basename(path.dirname(appBundle)).replace(/^mac-?/, '') || process.arch;
  const dmgPath = path.join(distDir, `${safeProductName}-${pkg.version}-${arch}.dmg`);

  await mkdir(distDir, { recursive: true });
  await rm(dmgPath, { force: true });
  await execFileAsync('hdiutil', [
    'create',
    '-volname',
    productName,
    '-srcfolder',
    appBundle,
    '-ov',
    '-format',
    'UDZO',
    dmgPath
  ]);

  console.log(`Created ${dmgPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
