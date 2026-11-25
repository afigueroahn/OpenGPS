# The restore helper: the Docker client and the script that handles the
# restore requests the platform's console leaves in the backups folder.
# Built at deploy time, like the database's image, so Dokploy needs nothing
# mounted from the repository.
FROM docker:29.9.2-cli
RUN apk add --no-cache bash
COPY deploy/restorer.sh /usr/local/bin/restorer.sh
RUN chmod 755 /usr/local/bin/restorer.sh
CMD ["/usr/local/bin/restorer.sh"]
