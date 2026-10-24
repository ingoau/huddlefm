FROM denoland/deno:bin AS deno

# The BgUtils proof-of-origin token server, built on the same base as the app
# so its native canvas module matches the runtime's libraries.
FROM oven/bun:debian AS pot-server
ARG BGUTIL_VERSION=2.0.2
COPY --from=deno /deno /usr/local/bin/deno
ADD https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz /tmp/bgutil.tar.gz
RUN mkdir /bgutil \
  && tar -xzf /tmp/bgutil.tar.gz -C /bgutil --strip-components=1 \
  && cd /bgutil/server \
  && DENO_DIR=/tmp/deno deno install --allow-scripts=npm:canvas --frozen

FROM oven/bun:debian
ARG BGUTIL_VERSION=2.0.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg fonts-noto-cjk fonts-noto-color-emoji \
    fonts-noto-core python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade --pre "yt-dlp[default]" \
    "bgutil-ytdlp-pot-provider==${BGUTIL_VERSION}"

COPY --from=deno /deno /usr/local/bin/deno
COPY --from=pot-server /bgutil/server /opt/bgutil/server
ENV PATH="/opt/yt-dlp/bin:${PATH}" \
    BGUTIL_SERVER_HOME=/opt/bgutil/server \
    BIND_ADDRESS=127.0.0.1 \
    PORT=3210

WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun index.ts tsconfig.json ./
COPY --chown=bun:bun src ./src

USER bun
VOLUME ["/app/data"]
EXPOSE 3210
CMD ["bun", "run", "start"]
