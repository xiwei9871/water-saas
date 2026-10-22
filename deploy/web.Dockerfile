FROM node:22-alpine AS build
RUN npm install --global pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/billing-core/package.json packages/billing-core/package.json
COPY packages/types/package.json packages/types/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
COPY tsconfig.base.json ./
RUN pnpm --filter @ws/types build && pnpm --filter web build
ARG RELEASE_SHA
RUN node -e 'require("fs").writeFileSync("apps/web/dist/release.json", JSON.stringify({commit:process.env.RELEASE_SHA, product:"Water SaaS", channel:"pilot"}))'

FROM nginx:1.27-alpine
ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
