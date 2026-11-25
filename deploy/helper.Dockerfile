# The platform's helper: the Docker client and the script that handles the
# requests the platform's console leaves in the backups folder (restore a
# backup, install a version), and the compose file of its version.
# Built at deploy time, like the database's image, so Dokploy needs nothing
# mounted from the repository.
FROM docker:29.9.2-cli
RUN apk add --no-cache bash
COPY deploy/helper.sh /usr/local/bin/helper.sh
# The compose file of this version: when it installs it, the helper takes it from here.
COPY deploy/docker-compose/docker-compose.yml /opt/opengps/docker-compose.yml
RUN chmod 755 /usr/local/bin/helper.sh
CMD ["/usr/local/bin/helper.sh"]
