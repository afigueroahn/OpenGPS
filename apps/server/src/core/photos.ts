// The person's photo: a small square the web app cuts before sending it. It
// lives in the database, so backups carry it and it leaves with the person.
import { USER_PHOTO_MAX_BYTES, USER_PHOTO_TYPES, type UserPhotoType } from "@opengps/shared";
import type { Queryable } from "../db";
import { badRequest, notFound } from "../errors";
import { say } from "../i18n";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the first bytes say the file is: the type in the header alone is not believed. */
export function photoTypeOf(data: Buffer): UserPhotoType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG)) return "image/png";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Where the photo is served; the address changes with each new photo, so browsers may keep it. */
const urlOf = (updatedAt: Date) => `/api/me/photo?v=${updatedAt.getTime()}`;

export async function photoUrlOf(db: Queryable, userId: string): Promise<string | null> {
  const r = await db.query<{ updated_at: Date }>(`SELECT updated_at FROM gps.user_photos WHERE user_id = $1`, [userId]);
  return r.rows[0] ? urlOf(r.rows[0].updated_at) : null;
}

/** Replaces the person's photo. Returns where the new one is served. */
export async function savePhoto(db: Queryable, userId: string, mime: string, data: Buffer): Promise<string> {
  if (data.length > USER_PHOTO_MAX_BYTES) throw badRequest(say("core.photo.tooBig", { kb: USER_PHOTO_MAX_BYTES / 1024 }), "photo_too_big");
  if (!(USER_PHOTO_TYPES as readonly string[]).includes(mime) || photoTypeOf(data) !== mime) throw badRequest(say("core.photo.type"), "photo_type");
  const r = await db.query<{ updated_at: Date }>(
    `INSERT INTO gps.user_photos (user_id, mime, data) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = clock_timestamp()
     RETURNING updated_at`,
    [userId, mime, data],
  );
  return urlOf((r.rows[0] as { updated_at: Date }).updated_at);
}

export async function readPhoto(db: Queryable, userId: string): Promise<{ mime: string; data: Buffer }> {
  const r = await db.query<{ mime: string; data: Buffer }>(`SELECT mime, data FROM gps.user_photos WHERE user_id = $1`, [userId]);
  const photo = r.rows[0];
  if (!photo) throw notFound(say("core.photo.notFound"));
  return photo;
}

export async function deletePhoto(db: Queryable, userId: string): Promise<void> {
  await db.query(`DELETE FROM gps.user_photos WHERE user_id = $1`, [userId]);
}
