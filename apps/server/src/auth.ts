// Sign-in, sign-up and accounts, with Better Auth over the `auth` schema.
//
// Each sign-up creates its own account (an "organization" of the library) and
// each session ends up pointing to the user's account. The rest of the backend
// only needs `sessionContext`: who it is and which account they are in.
//
// Besides email and password, people can sign in with the services the owner
// of the platform connected (Google, GitHub, Facebook, Apple or another one
// that speaks OpenID Connect). Those change from the console: the library is
// built again with them, without restarting.
import { randomBytes } from "node:crypto";
import { APP_OAUTH_FRESH_S, LEGAL_VERSION, type Language, PASSWORD_MAX, PASSWORD_MIN } from "@opengps/shared";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { admin, genericOAuth, oneTimeToken, organization } from "better-auth/plugins";
import type { IncomingHttpHeaders } from "node:http";
import type { Config } from "./config";
import { type Access, claimPlatformOwner, firstAccountWithoutMail, isPlatformOwner, resolveAccess } from "./core/access";
import { appleClientSecret, discoveryOf, oauthReady } from "./core/oauth";
import { writeMail } from "./core/mail-templates";
import { createPresence, recordSignIn, signInMethodOf } from "./core/presence";
import { recordConsent } from "./core/privacy";
import type { Db } from "./db";
import { AppError, badRequest, forbidden, notFound } from "./errors";
import { headerLanguage, knownLanguage, say, tr } from "./i18n";
import type { Mailer } from "./mail";

/** Who makes the request, which account they are in and what they can do and see there. */
export interface SessionContext extends Access {
  userId: string;
  userName: string;
  email: string;
  /** Administers the whole platform, not just their account. */
  platformAdmin: boolean;
  /** The language they chose; null = the platform's default. */
  language: Language | null;
}

/** Error code from the session library, if the error comes from it. */
const authErrorCode = (err: unknown): string | undefined => (err as { body?: { code?: string } })?.body?.code;

export type Auth = ReturnType<typeof createAuth>;

/** Header with the visitor's real IP; the backend writes it from what the proxy in front says, and no one else. */
export const CLIENT_IP_HEADER = "x-real-ip";
/**
 * Header with the page a request comes from, when that page is the web app itself at an address other than the
 * platform's own. The API writes it, and no one else (api/server.ts).
 */
export const OWN_ORIGIN_HEADER = "x-own-origin";

/** What is needed to delete the data of someone who deletes their account. */
export type BeforeUserDelete = (userId: string) => Promise<void>;

/** Body and headers of the request that caused a change, when known. */
interface HookContext {
  path?: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Headers;
}

/** Where Apple sends the person back from: the library has to accept it. */
const APPLE_ORIGIN = "https://appleid.apple.com";
/** Apple's secret is made again every day, so it never gets near the six months it lasts. */
const APPLE_SECRET_EVERY_MS = 24 * 60 * 60 * 1000;

/** What the account emails read from the configuration: the platform's name and address, and the words the console rewrote. */
type MailConfig = Pick<Config, "appName" | "publicUrl" | "mailTemplates">;

/** The email with the link to choose a new password, in a language. */
export const passwordResetMail = (config: MailConfig, url: string, language: Language) => writeMail(config.mailTemplates, "resetPassword", language, { app: config.appName }, url);

/** The email with the link that confirms an address, in a language. */
export const verificationMail = (config: MailConfig, url: string, language: Language) => writeMail(config.mailTemplates, "verifyEmail", language, { app: config.appName }, url);

/** The email to whoever tries to create an account with an email that already has one: how to come in. */
export const existingAccountMail = (config: MailConfig, language: Language) =>
  writeMail(config.mailTemplates, "existingAccount", language, { app: config.appName }, `${config.publicUrl}/login`);

export function createAuth(config: Config, db: Db, mailer: Mailer, beforeUserDelete?: BeforeUserDelete, hooks: { accountCreated?(account: { id: string; name: string }): void } = {}) {
  /**
   * The language of an account email: the one the screen is showing when it is asked for, then the browser's, then the platform's.
   * Nothing is looked up: the answer takes the same time whether the address exists or not.
   */
  const mailLanguage = (request?: Request): Language =>
    knownLanguage(request?.headers.get("x-language")) ?? headerLanguage(request?.headers.get("accept-language")) ?? config.defaultLanguage;
  /** Once there is an owner, there is no need to look again. */
  let ownerKnown = false;
  async function claimOwner(): Promise<void> {
    if (ownerKnown) return;
    ownerKnown = await claimPlatformOwner(db.core);
  }

  async function firstOrganizationId(userId: string): Promise<string | null> {
    const r = await db.core.query<{ organizationId: string }>(
      `SELECT "organizationId" FROM auth.member WHERE "userId" = $1 ORDER BY "createdAt", id LIMIT 1`,
      [userId],
    );
    return r.rows[0]?.organizationId ?? null;
  }

  /** Returns the user's account; if they do not have one yet, creates it. */
  async function ensureOrganization(user: { id: string; name?: string | null }): Promise<string> {
    const existing = await firstOrganizationId(user.id);
    if (existing) return existing;
    const created = await auth.api.createOrganization({
      body: {
        name: user.name?.trim() || tr(config.defaultLanguage, "api.auth.defaultAccountName"), // i18n: stored text
        slug: `c-${randomBytes(8).toString("hex")}`,
        userId: user.id,
      },
    });
    if (!created?.id) throw new Error(`Could not create the account of user ${user.id}`);
    // The account is born with the quotas and modules set by the platform settings.
    const start = config.newAccount;
    if (start.maxVehicles !== null || start.maxUsers !== null || start.modules.length > 0) {
      await db.core.query(`INSERT INTO gps.account_settings (org_id, max_vehicles, max_users, modules) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id) DO NOTHING`, [
        created.id,
        start.maxVehicles,
        start.maxUsers,
        start.modules,
      ]);
    }
    hooks.accountCreated?.({ id: created.id, name: created.name });
    return created.id;
  }

  /** The services people can sign in with, as they are connected now. None signs anyone up by itself: only the sign-up screen does. */
  const socialProviders = () => {
    const o = config.oauth;
    const base = { disableImplicitSignUp: true };
    return {
      ...(oauthReady(config, "google") ? { google: { ...base, clientId: o.google.clientId, clientSecret: o.google.secret, prompt: "select_account" as const } } : {}),
      ...(oauthReady(config, "github") ? { github: { ...base, clientId: o.github.clientId, clientSecret: o.github.secret } } : {}),
      ...(oauthReady(config, "facebook") ? { facebook: { ...base, clientId: o.facebook.clientId, clientSecret: o.facebook.secret } } : {}),
      ...(oauthReady(config, "apple") ? { apple: { ...base, clientId: o.apple.clientId, clientSecret: appleClientSecret(o.apple) } } : {}),
    };
  };
  /** Another service that speaks OpenID Connect, if it is connected. */
  const customProviders = () => {
    const c = config.oauth.custom;
    if (!oauthReady(config, "custom")) return [];
    const scopes = c.scopes.split(/[\s,]+/).filter(Boolean);
    // The person is who the service says in `sub`, as OpenID Connect names them; `id`, for one that names them otherwise.
    const accountSubject = ({ profile }: { profile: Record<string, unknown> }) => String(profile.sub ?? profile.id ?? "");
    return [{ providerId: "custom", discoveryUrl: discoveryOf(c.issuer), clientId: c.clientId, clientSecret: c.secret, scopes, pkce: true, disableImplicitSignUp: true, accountSubject }];
  };
  /** Whether someone has an invitation waiting for their email: with registration closed, only they sign up. */
  const invited = async (email: string): Promise<boolean> => {
    const r = await db.core.query(`SELECT 1 FROM auth.invitation WHERE lower(email) = lower($1) AND status = 'pending' AND "expiresAt" > now() LIMIT 1`, [email.trim()]);
    return (r.rowCount ?? 0) > 0;
  };
  /** The language a hook answers in: the one the app asks for, then the browser's, then the platform's. */
  const hookLanguage = (ctx: HookContext | null): Language =>
    knownLanguage(ctx?.headers?.get("x-language")) ?? headerLanguage(ctx?.headers?.get("accept-language")) ?? config.defaultLanguage;
  /**
   * The version of the terms accepted by whoever signs up: in what the sign-up screen sends, in what a mobile app
   * sends with the token it got from another service, or in what traveled to that service and back.
   */
  const acceptedIn = async (ctx: HookContext | null): Promise<unknown> => {
    if (ctx?.path === "/sign-up/email") return ctx.body?.legalVersion;
    if (ctx?.path === "/sign-in/social") return (ctx.body?.additionalData as { legalVersion?: unknown } | undefined)?.legalVersion;
    if (ctx?.path?.startsWith("/callback/")) return ((await getOAuthState().catch(() => null)) as { legalVersion?: unknown } | null)?.legalVersion;
    return undefined;
  };
  /** Whether someone is signing up with another service, rather than with an email and a password. */
  const throughService = (ctx: HookContext | null) => ctx?.path === "/sign-in/social" || Boolean(ctx?.path?.startsWith("/callback/"));

  const build = () =>
  betterAuth({
      appName: config.appName,
      baseURL: config.publicUrl,
      basePath: "/api/auth",
      secret: config.authSecret,
      database: db.auth,
      // The platform's address; the address the web app was opened by, when the API says it is another of its
      // own; and Apple, which posts the person back from its own page.
      trustedOrigins: (request) => [config.publicUrl, request?.headers.get(OWN_ORIGIN_HEADER), oauthReady(config, "apple") ? APPLE_ORIGIN : null],
      telemetry: { enabled: false },
      // A trip to another service that goes wrong comes back to the sign-in screen, which says why.
      onAPIError: { errorURL: `${config.publicUrl}/login?via=oauth` },
      socialProviders: socialProviders(),

      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        // The current policy is checked before reaching here; these are only its limits.
        minPasswordLength: PASSWORD_MIN,
        maxPasswordLength: PASSWORD_MAX,
        revokeSessionsOnPasswordReset: true,
        resetPasswordTokenExpiresIn: 60 * 60,
        // Someone signing up with an email that already has an account is answered the same as anyone else, so nobody
      // can find out which emails are registered; the email tells its owner how to come in instead.
      onExistingUserSignUp: async ({ user }, request) => {
        void mailer
          .send({ to: user.email, ...existingAccountMail(config, mailLanguage(request)) })
          .catch((err) => console.error("[mail] could not send the existing account notice:", err.message));
      },
      sendResetPassword: async ({ user, url }, request) => {
          // Without waiting for the send: the response must not reveal whether the email exists.
          void mailer
            .send({ to: user.email, ...passwordResetMail(config, url, mailLanguage(request)) })
            .catch((err) => console.error("[mail] could not send the password reset:", err.message));
        },
      },

      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        expiresIn: 24 * 60 * 60,
        sendVerificationEmail: async ({ user, url }, request) => {
          void mailer
            .send({ to: user.email, ...verificationMail(config, url, mailLanguage(request)) })
            .catch((err) => console.error("[mail] could not send the verification:", err.message));
        },
      },

      user: {
        // Deleting the account requires the password and first deletes all of the person's data.
        deleteUser: {
          enabled: true,
          beforeDelete: async (user, request) => {
            // The platform cannot be left without whoever administers it.
            if (await isPlatformOwner(db.core, user.id)) throw new APIError("FORBIDDEN", { code: "PLATFORM_OWNER", message: tr(mailLanguage(request), "api.auth.ownerStays") });
            await beforeUserDelete?.(user.id);
          },
        },
      },

      session: {
        expiresIn: 30 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60,
      },

      advanced: {
        cookiePrefix: "gps",
        ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      },

      plugins: [
        organization({
          // Today each user has their own account; the margin covers whoever administers several.
          organizationLimit: 5,
        }),
        admin(),
        genericOAuth({ config: customProviders() }),
        // The pass that takes a session from the system's browser to the mobile app (ADR-0013): it lasts a minute,
        // is kept hashed, works once, and only the platform hands it out.
        oneTimeToken({ expiresIn: 1, storeToken: "hashed", disableClientRequest: true }),
      ],

      hooks: {
        // Asking again for the confirmation of an email that is already confirmed sends nothing by itself: the email
        // tells its owner how to come in instead. The answer is the same either way.
        after: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== "/send-verification-email" || ctx.context.session) return;
          const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
          const found = email ? await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase()) : null;
          if (!found?.user.emailVerified) return;
          void mailer
            .send({ to: found.user.email, ...existingAccountMail(config, mailLanguage(ctx.request)) })
            .catch((err) => console.error("[mail] could not send the existing account notice:", err.message));
        }),
      },

      databaseHooks: {
        user: {
          create: {
            // Nobody signs up without accepting the current terms and policy.
            before: async (user, context) => {
              const ctx = context as HookContext | null;
              // Said in the language the app asks for, as the API answers its own errors.
              if ((ctx?.path === "/sign-up/email" || throughService(ctx)) && (await acceptedIn(ctx)) !== LEGAL_VERSION) {
                throw new APIError("BAD_REQUEST", { code: "LEGAL_NOT_ACCEPTED", message: tr(hookLanguage(ctx), "api.auth.legalNotAccepted") });
              }
              // A new installation without mail: its first account comes in without confirming its email and becomes the owner.
              if (ctx?.path === "/sign-up/email" && (await firstAccountWithoutMail(db.core, config.smtp.host))) return { data: { ...user, emailVerified: true } };
              // Signing up with another service follows the same rules as with an email, checked when it sends the person back.
              if (throughService(ctx)) {
                if (!config.registrationOpen && !(await invited(user.email))) throw new APIError("FORBIDDEN", { code: "REGISTRATION_CLOSED", message: tr(hookLanguage(ctx), "api.errors.registrationClosed") });
                // Facebook only shares an email it confirmed, but does not say so. That alone does not join it to an existing account.
                const provider = ctx?.params?.id ?? (ctx?.body?.provider as string | undefined);
                if (provider === "facebook") return { data: { ...user, emailVerified: true } };
              }
            },
            after: async (user, context) => {
              const ctx = context as HookContext | null;
              if ((await acceptedIn(ctx)) === LEGAL_VERSION) {
                await recordConsent(db.core, user.id, LEGAL_VERSION, ctx?.headers?.get(CLIENT_IP_HEADER) ?? null).catch((err) =>
                  console.error("[session] could not save the acceptance of the terms:", (err as Error).message),
                );
              }
              try {
                await ensureOrganization(user);
              } catch (err) {
                // It is retried on sign-in.
                console.error("[session] could not create the account at sign-up:", (err as Error).message);
              }
            },
          },
        },
        session: {
          create: {
            before: async (session) => {
              const r = await db.core.query<{ id: string; name: string; last_org_id: string | null }>(
                `SELECT u.id, u.name, s.last_org_id FROM auth."user" u LEFT JOIN gps.user_settings s ON s.user_id = u.id WHERE u.id = $1`,
                [session.userId],
              );
              const user = r.rows[0];
              if (!user) return;
              await ensureOrganization(user);
              // The last account they used is opened, if they still have access to it.
              const access = await resolveAccess(db.core, user.id, user.last_org_id, config.defaultLanguage);
              return { data: { ...session, activeOrganizationId: access?.orgId ?? null } };
            },
            // The platform's console shows when each person last came in and how. Someone else entering as them does not count.
            after: async (session, context) => {
              if ((session as { impersonatedBy?: string | null }).impersonatedBy) return;
              await recordSignIn(db.core, session.userId, signInMethodOf(context as HookContext | null)).catch((err) =>
                console.error("[session] could not note the sign-in:", (err as Error).message),
              );
            },
          },
        },
      },
    });
  let auth = build();
  const presence = createPresence(db.core);

  /** Session and active account of a request, or null if there is no valid session. */
  async function sessionContext(headers: IncomingHttpHeaders): Promise<SessionContext | null> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!result) return null;
    const { user, session } = result;
    const active = (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
    // The first person to sign up and confirm their email becomes the owner of the platform.
    if (user.emailVerified) await claimOwner();
    const settings = await db.core.query<{ language: string | null; owner: boolean }>(
      `SELECT (SELECT language FROM gps.user_settings WHERE user_id = $1) AS language, EXISTS (SELECT 1 FROM gps.platform_owners WHERE user_id = $1) AS owner`,
      [user.id],
    );
    const language = knownLanguage(settings.rows[0]?.language);
    // Membership and role are checked on every request: an old session
    // does not keep an access that was already withdrawn. The role's name
    // comes in the language the request is answered in.
    const answered = knownLanguage(headers["x-language"]) ?? language ?? headerLanguage(headers["accept-language"]) ?? config.defaultLanguage;
    const access = await resolveAccess(db.core, user.id, active, answered);
    if (!access) return null;
    const platformAdmin = user.emailVerified && settings.rows[0]?.owner === true;
    if (!(session as { impersonatedBy?: string | null }).impersonatedBy) presence.touch(user.id);
    return { userId: user.id, userName: user.name, email: user.email, platformAdmin, language, ...access };
  }

  /**
   * A one-time pass for the mobile app, from the session the trip to another service just left in the system's
   * browser (ADR-0013). An older session is not handed over: a page that opens this in a browser where someone
   * already had a session gets nothing.
   */
  async function appPass(headers: IncomingHttpHeaders): Promise<string | null> {
    const h = fromNodeHeaders(headers);
    const result = await auth.api.getSession({ headers: h });
    if (!result) return null;
    if (Date.now() - new Date(result.session.createdAt).getTime() > APP_OAUTH_FRESH_S * 1000) return null;
    const { token } = await auth.api.generateOneTimeToken({ headers: h });
    return token;
  }

  /** Accepts an invitation with the session of whoever received it. Returns the id of the accepted invitation. */
  async function acceptInvitation(headers: IncomingHttpHeaders, invitationId: string): Promise<void> {
    try {
      await auth.api.acceptInvitation({ headers: fromNodeHeaders(headers), body: { invitationId } });
    } catch (err) {
      const code = authErrorCode(err);
      if (code === "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION") {
        throw forbidden(say("api.invitation.otherEmail"));
      }
      if (code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") throw badRequest(say("api.invitation.alreadyMember"), "already_member");
      if (code === "INVITATION_NOT_FOUND" || code === "FAILED_TO_RETRIEVE_INVITATION") throw notFound(say("api.invitation.invalid"));
      if (err instanceof AppError) throw err;
      console.error("[session] could not accept the invitation:", code ?? (err as Error).message);
      throw badRequest(say("api.invitation.failed"));
    }
  }

  /** Switches the session's active account. The caller already checked that the person belongs to it. */
  async function setActiveAccount(headers: IncomingHttpHeaders, orgId: string): Promise<void> {
    await auth.api.setActiveOrganization({ headers: fromNodeHeaders(headers), body: { organizationId: orgId } });
  }

  // Apple's secret is made again before it gets old.
  setInterval(() => {
    if (oauthReady(config, "apple")) auth = build();
  }, APPLE_SECRET_EVERY_MS).unref();

  return {
    /** The library as it is now: it is built again when the services to sign in with change. */
    get auth() {
      return auth;
    },
    /** Builds the library again with the services connected now. */
    reload() {
      auth = build();
    },
    sessionContext,
    ensureOrganization,
    acceptInvitation,
    setActiveAccount,
    appPass,
  };
}
