# AtlasQuant AI — frontend (Vite build served by nginx)
# Build from the REPO ROOT:
#   docker build -f docker/frontend.Dockerfile \
#     --build-arg VITE_API_URL=https://api.example.com/api \
#     --build-arg VITE_WS_URL=wss://api.example.com -t atlasquant-frontend .
FROM node:22-alpine AS build
WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

# Vite inlines these at BUILD time (not runtime) — they must be the PUBLIC URLs the browser will call.
ARG VITE_API_URL=http://localhost:5000/api
ARG VITE_WS_URL=ws://localhost:5000
ENV VITE_API_URL=$VITE_API_URL VITE_WS_URL=$VITE_WS_URL

COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
