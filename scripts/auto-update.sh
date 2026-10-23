#!/bin/sh
# Move a running Markdown Studio onto the newest published image, if there is one.
#
#   scripts/auto-update.sh compose   # one machine, run from the repo checkout
#   scripts/auto-update.sh swarm     # Docker Swarm, run on the Pi that keeps the data
#
# Run it from cron or a systemd timer on the host. Nothing reaches in, so no
# ports need opening: the host asks GHCR whether the tag it is running (set by
# STUDIO_TAG when deployed: `latest` moves on every release, a version such as
# v1.2.0 never moves) points somewhere new. If it does, it backs up the database,
# switches to the new image and waits for it to be healthy. A version that fails
# its health check is rolled back and skipped until a newer one is published.
#
# Settings (environment): STUDIO_SERVICE (swarm only, default
# studio_markdown-studio) and BAD_IMAGE_FILE (where a rolled-back image is noted).
set -eu

MODE=${1:-}
BAD_IMAGE_FILE=${BAD_IMAGE_FILE:-/var/tmp/markdown-studio.bad-image}

log() { printf '%s auto-update: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "$*" >&2; exit 1; }

# A version that was rolled back is only retried once the tag moves on.
known_bad() { [ -f "$BAD_IMAGE_FILE" ] && [ "$(cat "$BAD_IMAGE_FILE")" = "$1" ]; }

# The digest the tag $REF points at in the registry (multi-arch index digest).
remote_digest() {
    docker buildx imagetools inspect "$REF" --format '{{json .Manifest}}' \
        | tr -d ' \t\n' \
        | sed -n 's/^[^[]*"digest":"\(sha256:[0-9a-f]*\)".*/\1/p'
}

update_compose() {
    cd "$(dirname "$0")/.."
    svc=markdown-studio
    cid=$(docker compose ps -q "$svc")
    [ -n "$cid" ] || die "the $svc container isn't running; start it with docker compose up -d"
    running=$(docker inspect -f '{{.Image}}' "$cid")
    REF=$(docker inspect -f '{{.Config.Image}}' "$cid")

    docker compose pull -q "$svc"
    latest=$(docker image inspect -f '{{.Id}}' "$REF")
    if [ "$running" = "$latest" ] || known_bad "$latest"; then
        exit 0
    fi

    log "new image for $REF, backing up first"
    docker compose exec -T -u app "$svc" scripts/backup.sh /data/studio.db /backups

    # Keep the old image under a tag so a failed start can go straight back to it.
    docker tag "$running" "${REF%:*}:previous"
    docker compose up -d --no-build "$svc"
    if wait_healthy "$(docker compose ps -q "$svc")"; then
        log "now running $(docker image inspect -f '{{index .RepoDigests 0}}' "$REF" 2>/dev/null || echo "$REF")"
        return
    fi

    log "new version failed its health check, going back to the previous image"
    echo "$latest" >"$BAD_IMAGE_FILE"
    docker tag "${REF%:*}:previous" "$REF"
    docker compose up -d --no-build --force-recreate "$svc"
    wait_healthy "$(docker compose ps -q "$svc")" || die "the previous image isn't healthy either; check docker compose logs"
    die "rolled back; the new image was not kept"
}

wait_healthy() {
    i=0
    while [ $i -lt 30 ]; do
        state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo gone)
        case $state in
            healthy) return 0 ;;
            unhealthy | exited | dead | gone) return 1 ;;
        esac
        i=$((i + 1))
        sleep 5
    done
    return 1
}

update_swarm() {
    service=${STUDIO_SERVICE:-studio_markdown-studio}
    current=$(docker service inspect -f '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$service") \
        || die "no service $service; deploy the stack first (see docker-stack.yml)"
    REF=${current%@*}
    latest=$(remote_digest)
    [ -n "$latest" ] || die "couldn't read the digest of $REF"
    case $current in
        *@"$latest") exit 0 ;;
    esac
    known_bad "$latest" && exit 0

    # The backup has to run where the data is: this script runs on that Pi.
    cid=$(docker ps -q -f "label=com.docker.swarm.service.name=$service" | head -n 1)
    [ -n "$cid" ] || die "$service isn't running on this node; run this on the Pi labelled studio.data=true"
    log "new image for $REF ($latest), backing up first"
    docker exec -u app "$cid" scripts/backup.sh /data/studio.db /backups

    # stop-first, monitor and rollback come from update_config in docker-stack.yml.
    if ! docker service update --quiet --with-registry-auth --image "$REF@$latest" "$service" >/dev/null; then
        echo "$latest" >"$BAD_IMAGE_FILE"
        die "the new version failed and Swarm rolled back; see docker service ps $service"
    fi
    log "now running $REF@$latest"
}

case $MODE in
    compose) update_compose ;;
    swarm) update_swarm ;;
    *) die "usage: $0 compose|swarm" ;;
esac
