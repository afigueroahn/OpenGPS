import { describe, expect, it } from "vitest";
import { liveUrl, normalizeServer, shareLink } from "./address";

describe("the address the person types", () => {
  it("is taken as https when it has no scheme", () => {
    expect(normalizeServer("demo.com")).toBe("https://demo.com");
  });

  it("keeps http for a local platform, with its port", () => {
    expect(normalizeServer("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeServer("http://192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
  });

  it("ignores spaces, capitals, the final slash and the /api of the address", () => {
    expect(normalizeServer("  HTTPS://Demo.com/  ")).toBe("https://demo.com");
    expect(normalizeServer("demo.com/api/")).toBe("https://demo.com");
    expect(normalizeServer("http://192.168.1.20:3000/api")).toBe("http://192.168.1.20:3000");
  });

  it("is not an address when empty, with spaces inside or with another scheme", () => {
    expect(normalizeServer("")).toBeNull();
    expect(normalizeServer("   ")).toBeNull();
    expect(normalizeServer("no es una dirección")).toBeNull();
    expect(normalizeServer("ftp://demo.com")).toBeNull();
    expect(normalizeServer("https://")).toBeNull();
    expect(normalizeServer("https://user@demo.com")).toBeNull();
  });
});

describe("a shared location", () => {
  it("opens the platform's own page, with the token after the #", () => {
    expect(shareLink("https://demo.com", "abc_DEF-123")).toBe("https://demo.com/shared#abc_DEF-123");
  });
});

describe("the live channel", () => {
  it("uses wss with https and ws with http", () => {
    expect(liveUrl("https://demo.com")).toBe("wss://demo.com/api/live");
    expect(liveUrl("http://localhost:3000")).toBe("ws://localhost:3000/api/live");
  });
});
