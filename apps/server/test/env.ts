import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.NODE_ENV = "test";
process.env.DISABLE_BACKGROUND = "true";
// Incident evidence is written to a temporary folder.
process.env.FILES_DIR = `${process.env.TMPDIR ?? "/tmp"}/opengps-test-files`;
// Backups made by the tests go to their own temporary folder.
process.env.BACKUP_DIR = `${process.env.TMPDIR ?? "/tmp"}/opengps-test-backups`;
process.env.TRACCAR_API_URL = "http://traccar.prueba:8082";
