FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/personifinn.db
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/server.js"]
