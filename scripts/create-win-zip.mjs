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

async function resolveWinAppDir() {
  const candidates = [
    path.join(distDir, 'win-unpacked'),
    path.join(distDir, 'win-x64-unpacked')
  ];

  for (const candidate of candidates) {
    if (await exists(path.join(candidate, `${productName}.exe`))) return candidate;
  }

  throw new Error(`Could not find a Windows unpacked app under ${distDir}. Run npm run desktop:dir:win first.`);
}

async function createZipWithPowerShell(sourceDir, zipPath) {
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path ${JSON.stringify(sourceDir)} -DestinationPath ${JSON.stringify(zipPath)} -Force`
  ]);
}

async function createZipWithZip(sourceDir, zipPath) {
  await execFileAsync('zip', ['-qry', zipPath, path.basename(sourceDir)], {
    cwd: path.dirname(sourceDir),
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  });
}

async function main() {
  const winAppDir = await resolveWinAppDir();
  const zipPath = path.join(distDir, `${safeProductName}-${pkg.version}-win-x64-portable.zip`);

  await mkdir(distDir, { recursive: true });
  await rm(zipPath, { force: true });

  if (process.platform === 'darwin') {
    await createZipWithZip(winAppDir, zipPath);
  } else if (process.platform === 'win32') {
    await createZipWithPowerShell(winAppDir, zipPath);
  } else {
    await createZipWithZip(winAppDir, zipPath);
  }

  console.log(`Created ${zipPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
