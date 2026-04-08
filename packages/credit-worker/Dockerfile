FROM node:22-alpine AS build
WORKDIR /app

# Native build deps for better-sqlite3 on ARM64
RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY packages/credit-worker/package*.json packages/credit-worker/
RUN npm ci --workspace=packages/credit-worker
COPY packages/credit-worker packages/credit-worker

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/credit-worker packages/credit-worker
COPY package*.json ./

RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "--import", "tsx", "packages/credit-worker/src/server.ts"]
