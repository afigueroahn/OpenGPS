// Shared map setup. The map processes tiles in a separate worker:
// its file is given explicitly so the bundler publishes it
// alongside the web app.
import { setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

setWorkerUrl(workerUrl);

export const FONT_BOLD = ["Noto Sans Bold"];
