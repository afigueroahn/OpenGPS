// Google Play receives the app signed with the upload key (ADR-0030). The key and its passwords stay out of the
// repository, in ~/.gradle/gradle.properties; without them the release build is signed with the debug key, as before.
const { withAppBuildGradle } = require("expo/config-plugins");

const KEY = "OPENGPS_UPLOAD_STORE_FILE";

const RELEASE_SIGNING = `
        release {
            if (findProperty('${KEY}')) {
                storeFile file(findProperty('${KEY}'))
                storePassword findProperty('OPENGPS_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('OPENGPS_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('OPENGPS_UPLOAD_KEY_PASSWORD')
            }
        }`;

module.exports = function uploadSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (gradle.includes(KEY)) return mod;
    // The release signing, next to the debug one; the release build takes it when the key is there.
    gradle = gradle.replace(/(signingConfigs \{\n\s*debug \{[^}]*\})/, `$1${RELEASE_SIGNING}`);
    gradle = gradle.replace(/(release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/, `$1signingConfig findProperty('${KEY}') ? signingConfigs.release : signingConfigs.debug`);
    // If Expo's template changes, the build must not go out unsigned without anyone noticing.
    if (!gradle.includes("signingConfigs.release : signingConfigs.debug") || !gradle.includes("storeFile file(findProperty")) {
      throw new Error("upload-signing: android/app/build.gradle does not have the shape this plugin expects");
    }
    mod.modResults.contents = gradle;
    return mod;
  });
};
