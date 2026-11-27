// The person's own corner: their photo, and how the platform notes when they
// last came in and how.
import { USER_PHOTO_MAX_BYTES, photoTypeFor } from "@opengps/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPresence, signInMethodOf } from "../src/core/presence";
import { type Harness, ORIGIN, type TestUser, createHarness } from "./harness";

let h: Harness;
let ana: TestUser;
let beto: TestUser;

beforeAll(async () => {
  h = await createHarness();
  ana = await h.signUp("Ana Foto");
  beto = await h.signUp("Beto Foto");
});
afterAll(async () => {
  await h?.close();
});

// The smallest files each type can be recognized by: only their first bytes matter here.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);

async function upload(user: TestUser | null, type: string, data: Buffer) {
  const res = await h.fastify.inject({
    method: "PUT",
    url: "/api/me/photo",
    headers: { "content-type": type, origin: ORIGIN, ...(user ? { cookie: user.cookie } : {}) },
    payload: data,
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}
const photoOf = (user: TestUser) => h.fastify.inject({ method: "GET", url: "/api/me/photo", headers: { cookie: user.cookie } });
const photoUrlOf = async (user: TestUser) => (await h.request("GET", "/api/me", { cookie: user.cookie })).json.user.photoUrl;

describe("profile photo", () => {
  it("starts without one", async () => {
    expect(await photoUrlOf(ana)).toBeNull();
    expect((await photoOf(ana)).statusCode).toBe(404);
  });

  it("is saved, served only to its owner and replaced", async () => {
    const saved = await upload(ana, "image/jpeg", JPEG);
    expect(saved.status).toBe(200);
    expect(saved.json.photoUrl).toMatch(/^\/api\/me\/photo\?v=\d+$/);
    expect(await photoUrlOf(ana)).toBe(saved.json.photoUrl);

    const served = await photoOf(ana);
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.rawPayload.equals(JPEG)).toBe(true);
    // Each person only ever gets their own.
    expect((await photoOf(beto)).statusCode).toBe(404);

    const replaced = await upload(ana, "image/png", PNG);
    expect(replaced.status).toBe(200);
    expect(replaced.json.photoUrl).not.toBe(saved.json.photoUrl);
    expect((await photoOf(ana)).headers["content-type"]).toBe("image/png");
  });

  it("refuses what is not an image of the allowed types, an empty file or one too large", async () => {
    // The header says one thing and the bytes another.
    expect(await upload(ana, "image/png", JPEG)).toMatchObject({ status: 400, json: { error: { code: "photo_type" } } });
    expect(await upload(ana, "image/jpeg", Buffer.from("no soy una imagen"))).toMatchObject({ status: 400, json: { error: { code: "photo_type" } } });
    expect((await upload(ana, "image/jpeg", Buffer.alloc(0))).status).toBe(400);
    const big = Buffer.concat([JPEG, Buffer.alloc(USER_PHOTO_MAX_BYTES)]);
    expect(await upload(ana, "image/jpeg", big)).toMatchObject({ status: 400, json: { error: { code: "photo_too_big" } } });
    expect((await upload(ana, "image/jpeg", Buffer.alloc(3 * USER_PHOTO_MAX_BYTES))).status).toBe(413);
    // What was there stays.
    expect((await photoOf(ana)).headers["content-type"]).toBe("image/png");
  });

  it("needs a session", async () => {
    expect((await upload(null, "image/jpeg", JPEG)).status).toBe(401);
    expect((await h.fastify.inject({ method: "GET", url: "/api/me/photo" })).statusCode).toBe(401);
    expect((await h.request("DELETE", "/api/me/photo", {})).status).toBe(401);
  });

  it("is taken away", async () => {
    expect((await h.request("DELETE", "/api/me/photo", { cookie: ana.cookie })).status).toBe(204);
    expect(await photoUrlOf(ana)).toBeNull();
    expect((await photoOf(ana)).statusCode).toBe(404);
  });
});

describe("type the web and the apps send the photo as", () => {
  it("keeps a picture that may be transparent as PNG, and sends any other as JPEG", () => {
    expect(photoTypeFor("image/png")).toBe("image/png");
    expect(photoTypeFor("image/webp")).toBe("image/png");
    expect(photoTypeFor("image/jpeg")).toBe("image/jpeg");
    // A phone's own format, which the platform does not take, goes as JPEG too.
    expect(photoTypeFor("image/heic")).toBe("image/jpeg");
  });
});

describe("last access and how they came in", () => {
  it("reads the way in from the route that opened the session", () => {
    expect(signInMethodOf({ path: "/sign-in/email" })).toBe("email");
    expect(signInMethodOf({ path: "/verify-email" })).toBe("email");
    expect(signInMethodOf({ path: "/callback/google", params: { id: "google" } })).toBe("google");
    expect(signInMethodOf({ path: "/callback/custom", params: { id: "custom" } })).toBe("custom");
    expect(signInMethodOf({ path: "/sign-in/social", body: { provider: "apple" } })).toBe("apple");
    expect(signInMethodOf({ path: "/callback/desconocido", params: { id: "desconocido" } })).toBeNull();
    expect(signInMethodOf({ path: "/change-password" })).toBeNull();
    expect(signInMethodOf(null)).toBeNull();
  });

  it("notes the sign-in", async () => {
    const row = await h.db.core.query(`SELECT sign_in_method, last_seen_at FROM gps.user_settings WHERE user_id = $1`, [beto.userId]);
    expect(row.rows[0].sign_in_method).toBe("email");
    expect(Date.now() - row.rows[0].last_seen_at.getTime()).toBeLessThan(60_000);
  });

  it("notes the use of the platform, at most every few minutes", async () => {
    const lastSeen = async () =>
      ((await h.db.core.query(`SELECT last_seen_at FROM gps.user_settings WHERE user_id = $1`, [beto.userId])).rows[0].last_seen_at as Date).getTime();
    await h.db.core.query(`UPDATE gps.user_settings SET last_seen_at = now() - interval '1 hour' WHERE user_id = $1`, [beto.userId]);
    const presence = createPresence(h.db.core);
    presence.touch(beto.userId);
    await expect.poll(lastSeen).toBeGreaterThan(Date.now() - 60_000);
    // Right after, another request writes nothing.
    await h.db.core.query(`UPDATE gps.user_settings SET last_seen_at = now() - interval '1 hour' WHERE user_id = $1`, [beto.userId]);
    presence.touch(beto.userId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await lastSeen()).toBeLessThan(Date.now() - 50 * 60_000);
  });
});
