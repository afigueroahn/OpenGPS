import type { DeviceModel } from "@opengps/shared";
import { describe, expect, it } from "vitest";
import { cleanId, fillSetup, isValidId, modelOptions } from "./gps";

const family = (id: string, brand: string, name: string, models: string[], examples = ""): DeviceModel => ({
  id,
  brand,
  name,
  examples,
  protocol: id,
  port: 5000,
  idLabel: "IMEI",
  setup: [],
  models,
});
const catalog = [family("teltonika", "Teltonika", "Teltonika serie FM", ["Teltonika FMC920", "Teltonika FMB920"], "FMC920, FMB920"), family("gt06", "Concox", "Concox / Jimi GT06", ["Concox GT06N"])];

describe("finding the GPS model", () => {
  it("finds a model by part of its name, without minding capitals or accents", () => {
    const found = modelOptions(catalog, "fmc 920");
    expect(found.map((o) => o.modelName)).toContain("Teltonika FMC920");
    expect(found.every((o) => o.modelId === "teltonika")).toBe(true);
  });

  it("lists only the models that match, not the rest of their family", () => {
    const names = modelOptions(catalog, "fmc 920").map((o) => o.modelName);
    expect(names).not.toContain("Teltonika FMB920");
    expect(names).toEqual(["Teltonika FMC920", null]);
  });

  it("offers the other model of a brand when the brand matches", () => {
    const found = modelOptions(catalog, "concóx");
    expect(found).toContainEqual(expect.objectContaining({ modelId: "gt06", modelName: null }));
  });

  it("lists everything with nothing typed, and nothing for an unknown name", () => {
    expect(modelOptions(catalog, "")).toHaveLength(5);
    expect(modelOptions(catalog, "zzz")).toHaveLength(0);
  });
});

describe("the device identifier", () => {
  it("drops the spaces people type between groups of digits", () => {
    expect(cleanId(" 356 938 035 643 809 ")).toBe("356938035643809");
  });

  it("accepts letters and numbers from 6 to 20, as the platform does", () => {
    expect(isValidId("356938035643809")).toBe(true);
    expect(isValidId("12345")).toBe(false);
    expect(isValidId("3569-3803")).toBe(false);
  });
});

describe("the setup instructions", () => {
  it("are filled in with this platform's server and the family's port", () => {
    expect(fillSetup("setparam 2004:{host};2005:{port}", { host: "gps.example.com", ip: null, port: 5027 })).toBe("setparam 2004:gps.example.com;2005:5027");
    expect(fillSetup("adminip123456 {ip} {port}", { host: "gps.example.com", ip: "203.0.113.5", port: 5001 })).toBe("adminip123456 203.0.113.5 5001");
  });
});
