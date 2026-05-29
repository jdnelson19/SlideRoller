const path = require('path');
const { notarize } = require('@electron/notarize');

module.exports = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const appleTeamId = process.env.APPLE_TEAM_ID;

  const apiKey = process.env.APPLE_API_KEY;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;

  const hasAppleIdFlow = Boolean(appleId && appleIdPassword && appleTeamId);
  const hasApiKeyFlow = Boolean(apiKey && apiKeyId && apiIssuer);
  const hasKeychainProfile = Boolean(keychainProfile);

  if (!hasKeychainProfile && !hasAppleIdFlow && !hasApiKeyFlow) {
    console.warn('WARNING: Skipping notarization — no credentials configured.');
    console.warn('Set APPLE_KEYCHAIN_PROFILE, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID,');
    console.warn('or APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER and rebuild before distributing.');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`Notarizing ${appPath}...`);

  const options = {
    tool: 'notarytool',
    appBundleId: packager.appInfo.id,
    appPath
  };

  if (hasKeychainProfile) {
    options.keychainProfile = keychainProfile;
  } else if (hasApiKeyFlow) {
    options.appleApiKey = apiKey;
    options.appleApiKeyId = apiKeyId;
    options.appleApiIssuer = apiIssuer;
  } else {
    options.appleId = appleId;
    options.appleIdPassword = appleIdPassword;
    options.teamId = appleTeamId;
  }

  await notarize(options);

  console.log('Notarization completed.');
};
