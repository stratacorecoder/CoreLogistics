FROM node:24-alpine AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/ui/package.json ./packages/ui/
COPY apps/api/package.json ./apps/api/
COPY apps/control-tower/package.json ./apps/control-tower/
COPY apps/gate/package.json ./apps/gate/
COPY apps/warehouse/package.json ./apps/warehouse/
COPY apps/driver/package.json ./apps/driver/
RUN npm ci

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3100
ENV CORELOGISTICS_DATA_DIR=/app/data
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages ./packages
COPY --from=dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY . .

RUN mkdir -p /app/data

EXPOSE 3100

CMD ["npm", "run", "start", "-w", "@corelogistics/api"]
