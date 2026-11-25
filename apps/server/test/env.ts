import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.NODE_ENV = "test";
process.env.DISABLE_BACKGROUND = "true";
// Incident evidence is written to a temporary folder.
process.env.FILES_DIR = `${process.env.TMPDIR ?? "/tmp"}/opengps-test-files`;
// Backups made by the tests go to their own temporary folder.
process.env.BACKUP_DIR = `${process.env.TMPDIR ?? "/tmp"}/opengps-test-backups`;
// The address service starts off: no test reaches OpenStreetMap's public one.
process.env.GEOCODER_URL = "";
// So does the routing service: no test reaches the public one.
process.env.ROUTING_URL = "";
// Who operates the installation under test, shown in the legal texts.
process.env.LEGAL_ENTITY = "Operador de Prueba";
// The platform's own gateway goes by names of its own, so a local test gateway on 127.0.0.1 is "another server".
process.env.DEVICE_GATEWAY_HOST = "gw.plataforma.prueba";
process.env.DEVICE_GATEWAY_IP = "203.0.113.10";
process.env.TRACCAR_API_URL = "http://traccar.prueba:8082";
