import { describe, expect, it } from "vitest";
import { mergeCookies } from "./cookies";

const NOW = Date.parse("2026-11-26T12:00:00Z");

describe("the session cookie the app keeps", () => {
  it("keeps the session cookie the platform sets, without its attributes", () => {
    expect(mergeCookies("", "gps.session_token=abc.def; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax", NOW)).toBe(
      "gps.session_token=abc.def",
    );
  });

  it("reads several cookies joined in one header, even with a date that has a comma", () => {
    const header = "gps.session_token=abc; Expires=Wed, 21 Dec 2026 07:28:00 GMT; Path=/, gps.session_data=xyz; Path=/";
    expect(mergeCookies("", header, NOW)).toBe("gps.session_token=abc; gps.session_data=xyz");
  });

  it("replaces a cookie it already had", () => {
    expect(mergeCookies("gps.session_token=old", "gps.session_token=new; Path=/", NOW)).toBe("gps.session_token=new");
  });

  it("forgets a cookie the platform removes, by Max-Age, by a past expiry or by an empty value", () => {
    const current = "gps.session_token=abc; gps.session_data=xyz";
    expect(mergeCookies(current, "gps.session_token=; Max-Age=0; Path=/", NOW)).toBe("gps.session_data=xyz");
    expect(mergeCookies(current, "gps.session_data=xyz; Expires=Thu, 01 Jan 1970 00:00:00 GMT", NOW)).toBe("gps.session_token=abc");
    expect(mergeCookies(current, "gps.session_token=", NOW)).toBe("gps.session_data=xyz");
  });

  it("ignores cookies that are not the platform's session", () => {
    expect(mergeCookies("", "tracking=1; Path=/", NOW)).toBe("");
  });

  it("keeps the session cookie of a platform on https, with its __Secure- prefix", () => {
    expect(mergeCookies("", "__Secure-gps.session_token=abc; Path=/; Secure; HttpOnly", NOW)).toBe("__Secure-gps.session_token=abc");
  });
});
