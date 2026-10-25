FROM node:22-slim AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM caddy:2
COPY caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend /app/dist /srv
