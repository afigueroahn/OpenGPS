import rootPackage from "../../../package.json" with { type: "json" };

/**
 * The version a build reports when it is not a release image: the
 * repository's own, marked as a development build. A release image sets
 * APP_VERSION to the release's (ADR-0003).
 */
export const SOURCE_VERSION = `${rootPackage.version}-dev`;
