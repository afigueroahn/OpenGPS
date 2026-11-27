// The Android app also reaches a platform installed without a domain, at http://IP:3000, as the iPhone app does
// (ADR-0026). Android blocks http:// in the app built to install unless the manifest allows it.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function allowHttp(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
};
