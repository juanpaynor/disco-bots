# Build from the REPO ROOT so prisma/ is in context:
#   docker build -f worker/Dockerfile -t aidisco-worker .
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY worker/package.json ./worker/
COPY prisma ./prisma/

WORKDIR /app/worker
RUN npm install

COPY worker/tsconfig.json ./
COPY worker/src ./src

RUN npx prisma generate && npm run build

# Persist browser profiles across deploys. Mount a Railway volume here, or the
# bots lose their logins on every push.
ENV PROFILE_DIR=/data/profiles
VOLUME ["/data"]

# Run HEADED under a virtual display, not headless.
#
# This is not a preference — it is measured. Headless Chromium gets a 403 from
# Cloudflare on chatgpt.com even from a clean residential IP, while headed on the
# SAME IP gets 200. The automation signals headless exposes are what gets scored,
# so a proxy alone does not fix it. Xvfb gives Chromium a real display inside a
# container that has none.
ENV HEADLESS=false
ENV DISPLAY=:99

CMD ["xvfb-run", "-a", "--server-args=-screen 0 1440x900x24", "npm", "start"]
