FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/

RUN cd packages/web && pnpm build

FROM node:22-slim AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile --prod

COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY --from=builder /app/packages/web/dist packages/web/dist

ENV CC_PET_PORT=3000
ENV CC_PET_DATA_DIR=/data

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
