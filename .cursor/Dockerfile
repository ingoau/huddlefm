# Cloud Agent development image for HuddleFM.
# Mirrors the production runtime (Bun + Chromium + ffmpeg + yt-dlp + Deno) so the
# media bridge, track search, and lyrics services all work, while leaving
# dependency installation and source checkout to Cursor's install phase.
FROM denoland/deno:bin AS deno

FROM oven/bun:debian

# System packages: Chromium (media bridge browser), ffmpeg (audio processing),
# Noto fonts (artwork/lyrics rendering), python venv (yt-dlp), and git/curl for
# the agent. Chromium here is a real Debian binary launched as the non-root
# `bun` user, so the app's default sandboxed launch args work unchanged.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium ffmpeg fonts-noto-cjk fonts-noto-color-emoji \
    fonts-noto-core python3 python3-venv git curl \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp in an isolated virtualenv, matching the production Dockerfile.
RUN python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade --pre "yt-dlp[default]"

COPY --from=deno /deno /usr/local/bin/deno

ENV PATH="/opt/yt-dlp/bin:${PATH}" \
    CHROME_PATH=/usr/bin/chromium

USER bun
