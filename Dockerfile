FROM node:22-slim AS builder

# 设置时区为 Asia/Shanghai
RUN apt-get update && apt-get install -y tzdata \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy all package.json files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Copy source files needed for web build (before install to fix pnpm symlinks)
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/

# Install only web and shared dependencies (avoid building native deps like better-sqlite3)
RUN pnpm install --frozen-lockfile --filter @cc-pet/web --filter @cc-pet/shared

RUN pnpm --filter @cc-pet/web build

FROM node:22-slim AS runner

# 设置时区为 Asia/Shanghai
RUN apt-get update && apt-get install -y tzdata \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai

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
