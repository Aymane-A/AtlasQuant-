# AtlasQuant AI — backend (Node/Express + WebSockets)
# Build from the REPO ROOT:  docker build -f docker/backend.Dockerfile -t atlasquant-backend .
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install production deps first (better layer caching). ccxt/bufferutil may need build tools.
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./
# The app writes logs/ — give the unprivileged user ownership.
RUN mkdir -p logs && chown -R node:node /app
USER node

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app.js"]
