-- Passkeys (ADR-0020): the table of Better Auth 1.7.27's passkey plugin. Only the
-- public key and its details are kept, never a password or biometric data; a
-- person's passkeys go with their user.
-- Generated with `pnpm --filter @opengps/server auth:schema`. Do not edit by hand.
-- Undone with: DROP TABLE auth.passkey;
SET LOCAL search_path TO auth;

create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" boolean not null, "transports" text, "createdAt" timestamptz, "aaguid" text);

create index "passkey_userId_idx" on "passkey" ("userId");

create index "passkey_credentialID_idx" on "passkey" ("credentialID");
