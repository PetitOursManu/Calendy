FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

# Dépendances d'exécution : exceljs (export Excel), le SDK Anthropic (agent IA) et le client MCP (visuels Mocky).
# Le connecteur MCP pour Claude Desktop est empaqueté à part (dist/).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js agent.js mocky.js seed.json ./
COPY public ./public

# Les données (data.json) vivent dans un volume : elles survivent aux mises à jour de l'image.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
