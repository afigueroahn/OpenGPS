// Where the GPS devices are pointed, without anybody writing it down: the name
// comes from the platform's address, and its IP from what the DNS answers for
// that name. The DNS is simulated: no test looks a name up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gatewayOf } from "../src/config";
import { createGatewayAddress } from "../src/core/gateway";
import { GATEWAY_IP, type Harness, createHarness } from "./harness";

describe("the name of the device gateway", () => {
  it("is gw. and the platform's domain", () => {
    expect(gatewayOf("https://example.com")).toEqual({ host: "gw.example.com", ip: null });
    expect(gatewayOf("https://gps.example.com:8443/")).toEqual({ host: "gw.gps.example.com", ip: null });
  });

  it("is the platform's own place when that is an IP or this same machine", () => {
    expect(gatewayOf("http://192.168.1.10:3000")).toEqual({ host: "192.168.1.10", ip: "192.168.1.10" });
    expect(gatewayOf("http://[2001:db8::1]:3000")).toEqual({ host: "2001:db8::1", ip: "2001:db8::1" });
    expect(gatewayOf("http://localhost:5173")).toEqual({ host: "localhost", ip: null });
  });
});

describe("the IP of the device gateway", () => {
  const MINUTE = 60_000;
  /** A DNS whose answer the test changes, and a clock it moves. */
  const world = (answer: string | null | "down") => {
    const state = { answer, asked: [] as string[], now: 0 };
    const config = { gatewayHost: "gw.example.com", gatewayIp: null as string | null };
    const address = createGatewayAddress(
      config,
      async (host) => {
        state.asked.push(host);
        if (state.answer === "down") throw new Error("the DNS does not answer");
        return state.answer;
      },
      () => state.now,
    );
    return { state, config, address };
  };

  it("is where its name points", async () => {
    const { state, config, address } = world("198.51.100.7");
    await address.refresh();
    expect(state.asked).toEqual(["gw.example.com"]);
    expect(config.gatewayIp).toBe("198.51.100.7");
  });

  it("is none while the name points nowhere, and appears once it does", async () => {
    const { state, config, address } = world(null);
    await address.refresh();
    expect(config.gatewayIp).toBeNull();
    state.answer = "198.51.100.7";
    await address.refresh();
    expect(config.gatewayIp).toBe("198.51.100.7");
  });

  it("stays as it was while the DNS does not answer", async () => {
    const { state, config, address } = world("198.51.100.7");
    await address.refresh();
    state.answer = "down";
    await address.refresh();
    expect(config.gatewayIp).toBe("198.51.100.7");
  });

  it("is looked up again only when the last answer is old", async () => {
    const { state, config, address } = world("198.51.100.7");
    const settled = () => new Promise((resolve) => setImmediate(resolve));
    await address.refresh();
    state.answer = "198.51.100.9";
    state.now = 4 * MINUTE;
    address.touch();
    await settled();
    expect(state.asked).toHaveLength(1);
    expect(config.gatewayIp).toBe("198.51.100.7");
    state.now = 5 * MINUTE;
    address.touch();
    await settled();
    expect(state.asked).toHaveLength(2);
    expect(config.gatewayIp).toBe("198.51.100.9");
  });
});

describe("what the web app is told", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("the gateway's name and the IP the DNS answers for it", async () => {
    const res = await h.request("GET", "/api/config");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ gatewayHost: h.config.gatewayHost, gatewayIp: GATEWAY_IP });
  });
});
