# syntax=docker/dockerfile:1
# One image for the whole suite: the Python API serves the built front end.
# Builds for linux/amd64 and linux/arm64 (Raspberry Pi 4/5 on a 64-bit OS).

# ---- Stage 1: build the web app (React + Vite). The output is plain static
# files, so this stage runs on the build machine's own architecture.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY web/ web/
RUN npm run build

# ---- Stage 2: Python runtime
FROM python:3.13-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    APP_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    DATABASE_PATH=/data/studio.db \
    STATIC_DIR=/app/web \
    PUID=1000 \
    PGID=1000

# Pango and fonts for PDF export (WeasyPrint).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
COPY packages/powertools-auth/ ./packages/powertools-auth/
RUN pip install -r requirements.txt && rm -rf ./packages

# Unprivileged user. The entrypoint re-maps it to PUID/PGID so files in the
# mounted /data directory are owned by your host user.
RUN groupadd --gid 1000 app && useradd --uid 1000 --gid app --no-create-home --shell /usr/sbin/nologin app

COPY server/studio/ ./studio/
COPY scripts/ ./scripts/
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=web /build/web/dist ./web
RUN chmod +x /usr/local/bin/entrypoint.sh ./scripts/*.sh \
    && mkdir -p /data /backups

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/health', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["python", "-m", "studio"]
