// Pack every public workspace package with pnpm (as a release would) and fail
// if a packed package.json still contains a `workspace:` dependency.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'mieweb-packs-'));
let bad = 0;
try {
  for (const dir of readdirSync('packages')) {
    const pkgPath = join('packages', dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.private) continue;
    const file = execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: join('packages', dir), encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop();
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json'], { encoding: 'utf8' }));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (String(range).startsWith('workspace:')) {
          console.error(`${pkg.name}: ${field}.${name} is still "${range}" in the packed tarball`);
          bad += 1;
        }
      }
    }
    console.log(`ok ${pkg.name}@${manifest.version}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
