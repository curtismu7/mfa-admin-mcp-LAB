# Two stages: the first builds the web UI, the final image carries the server and the built UI only.
# Node 26 only (rulebook). Docker on OrbStack, never Docker Desktop.
# The image holds no tenant value and no secret. Live is off unless the owner passes PINGONE_MCP_INSPECTOR_MODE=live at run time.
FROM node:26-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts -w web --include-workspace-root=false && npm cache clean --force
COPY web web
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=5201 P1MCP_DATA_DIR=/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server --ignore-scripts && npm cache clean --force
COPY server/src server/src
# The diagrams are diagram-studio/1 data files, validated when the server starts: the image must carry them.
COPY server/diagrams server/diagrams
COPY --from=web /app/web/dist web/dist
# The data dir holds the saved connections (mode 600 file, including worker secrets) and the audit log: mode 700, owned by the non-root user.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 5201
VOLUME /data
# Inside the container the server must listen on all interfaces, so P1MCP_BIND is set here on purpose.
# The compose file publishes the port on 127.0.0.1 only; do not publish it more widely: Live can act on a PingOne tenant.
ENV P1MCP_BIND=0.0.0.0
# P1MCP_CONTAINER=1 tells the Live loopback-bind guard that this wide bind is the container's (published on 127.0.0.1 only). A host run does not get it.
ENV P1MCP_CONTAINER=1
CMD ["node", "server/src/index.js"]
