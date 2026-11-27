import { describe, expect, it } from "vitest";
import { problemOf, readAppReturn, readPasskeyReturn, readQuery, writeQuery } from "./oauth";

describe("coming back to the app from another service", () => {
  it("brings the pass to exchange for the session", () => {
    expect(readAppReturn("opengps://oauth?token=abc123")).toEqual({ token: "abc123" });
  });

  it("brings the reason when there is no pass", () => {
    expect(readAppReturn("opengps://oauth?error=access_denied")).toEqual({ error: "access_denied", description: null });
    expect(readAppReturn("opengps://oauth?error=REGISTRATION_CLOSED&error_description=Cerrado")).toEqual({ error: "REGISTRATION_CLOSED", description: "Cerrado" });
  });

  it("ignores any other address", () => {
    expect(readAppReturn("https://ejemplo.com/oauth?token=abc")).toBeNull();
    expect(readAppReturn("opengps://otra?token=abc")).toBeNull();
    expect(readAppReturn("no es una dirección")).toBeNull();
  });
});

describe("coming back to the app from creating a passkey", () => {
  it("says it was created", () => {
    expect(readPasskeyReturn("opengps://passkey?created=1")).toEqual({ created: true });
  });

  it("brings the reason when it was not", () => {
    expect(readPasskeyReturn("opengps://passkey?error=access_denied")).toEqual({ error: "access_denied" });
    expect(readPasskeyReturn("opengps://passkey?error=unavailable")).toEqual({ error: "unavailable" });
    expect(readPasskeyReturn("opengps://passkey")).toEqual({ error: "failed" });
  });

  it("ignores any other address", () => {
    expect(readPasskeyReturn("opengps://oauth?token=abc")).toBeNull();
    expect(readPasskeyReturn("opengps://passkeys?created=1")).toBeNull();
    expect(readPasskeyReturn("https://ejemplo.com/passkey?created=1")).toBeNull();
  });
});

describe("what to tell the person", () => {
  it("says the platform's own words about the terms and registration", () => {
    expect(problemOf("REGISTRATION_CLOSED", "El registro está cerrado")).toEqual({ text: "El registro está cerrado" });
  });

  it("explains the service's reasons, and anything else as a failure", () => {
    expect(problemOf("access_denied", null)).toEqual({ key: "services.cancelled" });
    expect(problemOf("account_not_linked", null)).toEqual({ key: "services.notLinked" });
    expect(problemOf("no_session", null)).toEqual({ key: "services.failed" });
  });
});

describe("the addresses' queries", () => {
  it("are written and read back with what needs encoding", () => {
    const query = writeQuery({ provider: "custom", legalVersion: "2026-11-21", note: "a b&c" });
    expect(query).toBe("provider=custom&legalVersion=2026-11-21&note=a%20b%26c");
    expect(readQuery(query)).toEqual({ provider: "custom", legalVersion: "2026-11-21", note: "a b&c" });
  });
});
