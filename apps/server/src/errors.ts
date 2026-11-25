// Errors with a defined response for the API.
import { type Say, render, say } from "./i18n";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** What went wrong: a key of the catalogs, said to each reader in their language, or a text already written. */
    readonly text: Say | string,
  ) {
    // `message` is for the server's own log and for whoever catches it there: in the reference language.
    super(render("es", text));
    this.name = "AppError";
  }
}

export const unauthorized = () => new AppError(401, "unauthorized", say("api.errors.signIn"));
export const forbidden = (message: Say | string = say("api.errors.forbidden")) => new AppError(403, "forbidden", message);
export const notFound = (message: Say | string = say("api.errors.notFound")) => new AppError(404, "not_found", message);
export const conflict = (code: string, message: Say | string) => new AppError(409, code, message);
export const badRequest = (message: Say | string, code = "invalid_request") => new AppError(400, code, message);
export const tooMany = (message: Say | string) => new AppError(429, "too_many_requests", message);
