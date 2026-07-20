#!/usr/bin/env node
/*
 * Updates the vendored Adobe libraries in src/ from their official distribution channels:
 * - Adobe Experience Platform WebSDK (alloy) from the CDN documented for self-hosting:
 *   https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/install/self-hosting
 * - Adobe Client Data Layer from the official npm package tarball
 * It also keeps the version numbers in the README's Dependencies section in sync.
 *
 * Usage: node scripts/update-vendor.mjs [<alloy-version>] [<acdl-version>]
 * Versions default to the latest published on npm.
 */
import { execSync } from 'node:child_process';
import {
  mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function latestVersion(pkg) {
  return execSync(`npm view ${pkg} version`, { encoding: 'utf-8' }).trim();
}

const [
  alloyVersion = latestVersion('@adobe/alloy'),
  acdlVersion = latestVersion('@adobe/adobe-client-data-layer'),
] = process.argv.slice(2);

// Fetch the prebuilt WebSDK bundle from the self-hosting CDN (the npm package only ships
// the sources, not the standalone browser build)
const alloyUrl = `https://cdn1.adoberesources.net/alloy/${alloyVersion}/alloy.min.js`;
console.log(`Fetching ${alloyUrl}`);
const res = await fetch(alloyUrl);
if (!res.ok) {
  throw new Error(`Could not download alloy ${alloyVersion}: HTTP ${res.status}`);
}
const alloySource = await res.text();
if (!alloySource.includes(alloyVersion)) {
  throw new Error(`The downloaded bundle does not look like alloy ${alloyVersion}`);
}
writeFileSync(join(root, 'src', 'alloy.min.js'), alloySource);

// Extract the ACDL minified build from the official npm tarball
console.log(`Fetching @adobe/adobe-client-data-layer@${acdlVersion} from npm`);
const tmp = mkdtempSync(join(tmpdir(), 'aem-martech-vendor-'));
try {
  execSync(`npm pack @adobe/adobe-client-data-layer@${acdlVersion}`, { cwd: tmp, stdio: 'pipe' });
  const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  execSync(`tar -xzf ${tarball}`, { cwd: tmp });
  const acdlSource = readFileSync(join(tmp, 'package', 'dist', 'adobe-client-data-layer.min.js'), 'utf-8');
  writeFileSync(join(root, 'src', 'acdl.min.js'), acdlSource);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Keep the README's Dependencies section in sync
const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf-8')
  .replace(/(\*\*Adobe Experience Platform WebSDK\*\*: )`v[\d.]+`/, `$1\`v${alloyVersion}\``)
  .replace(/(\*\*Adobe Client Data Layer\*\*: )`v[\d.]+`/, `$1\`v${acdlVersion}\``);
writeFileSync(readmePath, readme);

console.log(`Vendored alloy v${alloyVersion} and ACDL v${acdlVersion}. Review and commit the changes.`);
