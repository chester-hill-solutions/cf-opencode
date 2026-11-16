import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const forbidden = {
  'server secret configuration': /\b(?:DATABASE_URL|PGPASSWORD|AUTH_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SMTP_PASSWORD|RESEND_API_KEY|S3_SECRET_ACCESS_KEY)\b/,
  'server module': /(?:node:(?:fs|net|tls|child_process)|@chester-hill-solutions\/(?:auth-postgres|eventkit-postgres)|\.server\.[cm]?[jt]s)/,
  'credential material': /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk_(?:live|test)_[A-Za-z0-9]{16,}|\bAKIA[A-Z0-9]{16})/,
};
export function bundleViolations(source) {
  return Object.entries(forbidden).filter(([, pattern]) => pattern.test(source)).map(([rule]) => rule);
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() && file.endsWith('.js') ? [file] : [];
  });
}
export function checkClientBundle(root = process.cwd()) {
  const sources = files(resolve(root, 'public/assets'));
  for (const entry of ['settings.js', 'onboarding.js', 'ui-kit.js', 'workspace.js']) {
    if (!sources.includes(resolve(root, 'public/assets', entry))) throw new Error(`Missing ${entry}; run bun run build:ui`);
  }
  const failures = sources.flatMap((file) => bundleViolations(readFileSync(file, 'utf8')).map((rule) => `${file}: ${rule} (allowed 0)`));
  if (failures.length) throw new Error(failures.join('\n'));
  return sources.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`check:client-bundle passed: ${checkClientBundle()} assets. No server imports or known credential markers.`); }
  catch (error) { console.error(`check:client-bundle failed: ${error.message}. Details: bun run check:client-bundle; move server work behind Worker API handlers.`); process.exitCode = 1; }
}
