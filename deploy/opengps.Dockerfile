# OpenGPS: the backend (API, sign-in, WebSocket, ingest and jobs) with the
# web app inside, served together on port 3000.
FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @opengps/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @opengps/server build

FROM node:26-alpine AS web
WORKDIR /repo
RUN npm install -g pnpm@12.21.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @opengps/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @opengps/web build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
# pg_dump, same version as the database, for the backups.
RUN apk add --no-cache postgresql18-client
# rclone, the tool that moves files to external storage. Pinned version,
# downloaded from the rclone site and with its checksum verified, for the
# server's architecture (Intel/AMD or ARM; Docker says which in TARGETARCH).
ARG TARGETARCH
ARG RCLONE_VERSION=1.76.0
ARG RCLONE_SHA256_AMD64=b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7
ARG RCLONE_SHA256_ARM64=ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78
RUN arch="${TARGETARCH:-amd64}" \
  && case "$arch" in amd64) sum="$RCLONE_SHA256_AMD64" ;; arm64) sum="$RCLONE_SHA256_ARM64" ;; *) echo "rclone: unsupported architecture $arch" >&2; exit 1 ;; esac \
  && wget -q -O /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${arch}.zip" \
  && echo "${sum}  /tmp/rclone.zip" | sha256sum -c - \
  && unzip -q /tmp/rclone.zip -d /tmp \
  && install -m 755 "/tmp/rclone-v${RCLONE_VERSION}-linux-${arch}/rclone" /usr/local/bin/rclone \
  && rm -rf /tmp/rclone.zip "/tmp/rclone-v${RCLONE_VERSION}-linux-${arch}" \
  && rclone version | head -1
COPY --from=build /repo/apps/server/dist ./dist
COPY db ./db
COPY --from=web /repo/apps/web/dist /app/web
ENV WEB_DIR=/app/web
RUN mkdir -p /data/files /data/backups && chown -R node:node /data/files /data/backups
USER node
EXPOSE 3000
CMD ["node", "dist/main.mjs"]
