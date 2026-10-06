# Build from the REPO ROOT so prisma/ is in context:
#   docker build -f worker/Dockerfile -t aidisco-worker .
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

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
ENV HEADLESS=true
VOLUME ["/data"]

CMD ["npm", "start"]
