# ---- frontend build -------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---- server dependencies (node-pty needs a toolchain) ---------------------
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine

# docker-cli + compose: used to update containers via their compose project.
# util-linux: provides nsenter, used for the host shell.
RUN apk add --no-cache \
      docker-cli \
      docker-cli-compose \
      util-linux \
      tini \
      bash \
      git \
      curl \
      ripgrep

# Claude Code, for the "Claude" terminal tab. OAuth login persists in
# $HOME (/data/home), which is on the ./data volume.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./
COPY --from=web /web/dist ./public

ENV NODE_ENV=production
EXPOSE 8090

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
