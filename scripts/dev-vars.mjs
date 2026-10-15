// Writes .dev.vars for local dev / e2e from .dev.vars.example with fresh random
// secrets. Leaves an existing .dev.vars alone unless --force.
//   --from-keychain  use the real Apple key from the macOS keychain
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const target = new URL('../.dev.vars', import.meta.url);
if (existsSync(target) && !args.has('--force')) {
  console.log('.dev.vars exists; pass --force to overwrite');
  process.exit(0);
}

let pem;
if (args.has('--from-keychain')) {
  const hex = execFileSync(
    'security',
    ['find-generic-password', '-a', 'claw', '-s', 'grub-apple-key-p8', '-w'],
    { encoding: 'utf8' },
  ).trim();
  // multi-line keychain secrets come back hex-encoded
  pem = Buffer.from(hex, 'hex').toString('utf8');
} else {
  pem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
}
if (!pem.includes('BEGIN PRIVATE KEY')) throw new Error('not a PKCS#8 PEM');

const secret = () => randomBytes(32).toString('base64url');
const values = {
  SESSION_HMAC_KEY: secret(),
  DEV_LOGIN_SECRET: secret(),
  APPLE_PRIVATE_KEY: `"${pem.trim().replaceAll('\n', '\\n')}"`,
};
const out = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => {
    const key = /^([A-Z_]+)=/.exec(line)?.[1];
    return key && key in values ? `${key}=${values[key]}` : line;
  })
  .join('\n');
writeFileSync(target, out, { mode: 0o600 });
console.log(
  `wrote .dev.vars (${args.has('--from-keychain') ? 'keychain' : 'throwaway'} Apple key)`,
);
