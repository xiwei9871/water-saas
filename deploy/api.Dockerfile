FROM node:22-alpine AS build
RUN apk add --no-cache openssl && npm install --global pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/billing-core/package.json packages/billing-core/package.json
COPY packages/types/package.json packages/types/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages packages
COPY tsconfig.base.json ./
COPY deploy/bootstrap.mjs deploy/bootstrap.mjs
COPY deploy/verify.mjs deploy/verify.mjs
RUN pnpm --dir apps/api exec prisma generate && pnpm --filter api build

FROM build AS runtime
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA
ENV NODE_ENV=production
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
