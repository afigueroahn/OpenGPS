// Where the uploads live: one folder per kind, then the account and the entity.
import { describe, expect, it } from "vitest";
import { filesFolder } from "../src/core/files";

describe("upload folders", () => {
  it("builds each path under its kind's folder", () => {
    expect(filesFolder({ filesDir: "/data/files" }, "maintenance", "org-1", "order-9")).toBe("/data/files/maintenance/org-1/order-9");
    expect(filesFolder({ filesDir: "/data/files" }, "fleet")).toBe("/data/files/fleet");
  });
});
