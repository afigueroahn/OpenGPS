# The platform's helper: the Docker client and the script that handles the
# requests the platform's console leaves in the backups folder (restore a
# backup, install a version), and the compose file of its version.
# Built at deploy time, like the database's image, so Dokploy needs nothing
# mounted from the repository.
FROM docker:29.9.2-cli
RUN apk add --no-cache bash
COPY deploy/helper.sh /usr/local/bin/helper.sh
# The compose files of this version, one per way of installing with Docker
# Compose: when it installs it, the helper takes from here the one of the way
# the installation has.
COPY deploy/docker-compose/docker-compose.yml /opt/opengps/docker-compose/docker-compose.yml
COPY deploy/caddy/docker-compose.yml /opt/opengps/caddy/docker-compose.yml
COPY deploy/cloudflare/docker-compose.yml /opt/opengps/cloudflare/docker-compose.yml
# Where the helpers from before the ways existed (0.1.x) look for it.
COPY deploy/docker-compose/docker-compose.yml /opt/opengps/docker-compose.yml
# They run the images of this version (ADR-0008). A release passes it, and
# its compose files already say it; built without it, they stay as they are.
ARG APP_VERSION=""
RUN if [ -n "$APP_VERSION" ]; then \
      sed -i -E "s#^([[:space:]]*image:[[:space:]]*ghcr\.io/afigueroahn/[a-z-]+):.*#\1:$APP_VERSION#" \
        /opt/opengps/*/docker-compose.yml /opt/opengps/docker-compose.yml; \
    fi
RUN chmod 755 /usr/local/bin/helper.sh
CMD ["/usr/local/bin/helper.sh"]
