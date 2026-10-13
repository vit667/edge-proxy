# Control panel: static build only, no Node.js dependencies at runtime.
FROM node:22-bookworm-slim AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY config.example.json ./
COPY --from=ui /ui/dist ./ui/dist
COPY docker-entrypoint.sh /usr/local/bin/
# /data holds the writable configuration; a named volume inherits this ownership.
RUN mkdir /data && chown node:node /data && chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
ENV HOST=0.0.0.0 UI_HOST=0.0.0.0 CONFIG_PATH=/data/config.json
VOLUME /data
EXPOSE 8787 8788
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/_edge/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
