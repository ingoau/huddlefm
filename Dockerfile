FROM denoland/deno:bin AS deno
FROM oven/bun:debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium ffmpeg python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade --pre "yt-dlp[default]"

COPY --from=deno /deno /usr/local/bin/deno
ENV PATH="/opt/yt-dlp/bin:${PATH}" \
    BIND_ADDRESS=0.0.0.0 \
    CHROME_PATH=/usr/bin/chromium \
    PORT=3210

WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun index.ts tsconfig.json ./
COPY --chown=bun:bun src ./src
RUN mkdir /app/dist && chown bun:bun /app/dist

USER bun
VOLUME ["/app/data"]
EXPOSE 3210
CMD ["bun", "run", "start"]
