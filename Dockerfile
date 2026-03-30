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
ENV NODE_ENV=production

EXPOSE 3000
VOLUME ["/data"]

# pnpm 将 workspace 依赖装在 packages/server/node_modules；`--import tsx` 从 cwd 解析，故 cwd 需为 server 包根目录。
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx", "src/index.ts"]
