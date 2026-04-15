FROM node:22-alpine AS build
WORKDIR /app

# Native build deps for better-sqlite3 on ARM64
RUN apk add --no-cache python3 make g++

# Full workspace install so both credit-worker and dashboard resolve their deps
COPY package*.json ./
COPY packages/credit-worker/package*.json packages/credit-worker/
COPY packages/dashboard/package*.json packages/dashboard/
RUN npm ci

COPY packages/credit-worker packages/credit-worker
COPY packages/dashboard packages/dashboard

# Produce the React bundle at packages/dashboard/dist
RUN npm run build --workspace=packages/dashboard

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/credit-worker packages/credit-worker
COPY --from=build /app/packages/dashboard/dist packages/dashboard/dist
COPY package*.json ./

RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "--import", "tsx", "packages/credit-worker/src/server.ts"]
