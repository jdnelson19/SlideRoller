#!/usr/bin/env node

const { execSync } = require('child_process');

function run(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : '';
    const stdout = error && error.stdout ? String(error.stdout).trim() : '';
    return stderr || stdout || String(error.message || error);
  }
}

function printSection(title) {
  console.log(`\n=== ${title} ===`);
}

function hasEnv(name) {
  return Boolean(process.env[name] && process.env[name].trim());
}

printSection('Code Signing Identities');
const identities = run('security find-identity -v -p codesigning');
console.log(identities || 'No output from security tool.');

const hasDeveloperId = /Developer ID Application:/i.test(identities);
if (!hasDeveloperId) {
  console.log('\nMissing Developer ID Application certificate.');
  console.log('Install one in your login keychain via Apple Developer certificates.');
}

printSection('Notarization Credentials');
const hasKeychainProfile = hasEnv('APPLE_KEYCHAIN_PROFILE');
const hasAppleIdFlow = hasEnv('APPLE_ID') && hasEnv('APPLE_APP_SPECIFIC_PASSWORD') && hasEnv('APPLE_TEAM_ID');
const hasApiKeyFlow = hasEnv('APPLE_API_KEY') && hasEnv('APPLE_API_KEY_ID') && hasEnv('APPLE_API_ISSUER');

console.log(`APPLE_KEYCHAIN_PROFILE: ${hasKeychainProfile ? 'set' : 'missing'}`);
console.log(`APPLE_ID flow vars: ${hasAppleIdFlow ? 'set' : 'missing'}`);
console.log(`App Store Connect API key vars: ${hasApiKeyFlow ? 'set' : 'missing'}`);

if (!hasKeychainProfile && !hasAppleIdFlow && !hasApiKeyFlow) {
  console.log('\nNo notarization credentials configured.');
  console.log('Set APPLE_KEYCHAIN_PROFILE, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID,');
  console.log('or APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER.');
}

printSection('electron-builder Identity Variable');
console.log(`CSC_NAME: ${hasEnv('CSC_NAME') ? process.env.CSC_NAME : 'missing'}`);

const ok = hasDeveloperId && (hasKeychainProfile || hasAppleIdFlow || hasApiKeyFlow);
console.log(`\nSigning readiness: ${ok ? 'READY' : 'NOT READY'}`);
process.exit(ok ? 0 : 1);
