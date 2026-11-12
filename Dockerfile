FROM node:24-alpine AS base
WORKDIR /app

FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/ui/package.json ./packages/ui/
COPY apps/api/package.json ./apps/api/
COPY apps/control-tower/package.json ./apps/control-tower/
COPY apps/gate/package.json ./apps/gate/
COPY apps/warehouse/package.json ./apps/warehouse/
COPY apps/driver/package.json ./apps/driver/

FROM manifests AS api-deps
RUN npm ci --omit=dev

FROM manifests AS web-builder
RUN npm ci
COPY tsconfig.web.json ./
COPY packages ./packages
COPY apps/control-tower ./apps/control-tower
COPY apps/gate ./apps/gate
COPY apps/warehouse ./apps/warehouse
COPY apps/driver ./apps/driver
ARG VITE_API_URL=/api
ARG VITE_ROLE_ROUTING=path
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_ROLE_ROUTING=$VITE_ROLE_ROUTING
RUN VITE_BASE_PATH=/ npm run build -w @corelogistics/control-tower \
 && VITE_BASE_PATH=/gate/ npm run build -w @corelogistics/gate \
 && VITE_BASE_PATH=/warehouse/ npm run build -w @corelogistics/warehouse \
 && VITE_BASE_PATH=/driver/ npm run build -w @corelogistics/driver

FROM api-deps AS api
ENV NODE_ENV=production
ENV PORT=3100
ENV CORELOGISTICS_DATA_DIR=/app/data
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3100
CMD ["npm", "run", "start", "-w", "@corelogistics/api"]

FROM caddy:2-alpine AS web
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=web-builder /app/apps/control-tower/dist /srv/tower
COPY --from=web-builder /app/apps/gate/dist /srv/gate
COPY --from=web-builder /app/apps/warehouse/dist /srv/warehouse
COPY --from=web-builder /app/apps/driver/dist /srv/driver
EXPOSE 80 443
