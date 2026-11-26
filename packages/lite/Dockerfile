FROM node:24.21.0-trixie AS builder

WORKDIR /service

COPY *.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
COPY ./packages/lite/package.json ./packages/lite/
COPY ./packages/api/package.json ./packages/api/
COPY ./packages/dashboard/package.json ./packages/dashboard/
COPY ./packages/worker/package.json ./packages/worker/
COPY ./packages/admin-cli/package.json ./packages/admin-cli/
COPY ./packages/backend-lib/package.json ./packages/backend-lib/
COPY ./packages/isomorphic-lib/package.json ./packages/isomorphic-lib/
COPY ./packages/emailo/package.json ./packages/emailo/

RUN yarn set version 4.1.1
RUN yarn workspaces focus lite --production && \
    cp -R node_modules production_node_modules
RUN yarn workspaces focus lite emailo

RUN mkdir -p packages/dashboard/public/public && \
    curl https://raw.githubusercontent.com/dittofeed/sdk-web/8ba1161ef3c59f276b30395dc84b3efbc20e6c2d/snippet/dittofeed.umd.js -o packages/dashboard/public/public/dittofeed.umd.js && \
    curl https://raw.githubusercontent.com/dittofeed/sdk-web/8ba1161ef3c59f276b30395dc84b3efbc20e6c2d/snippet/dittofeed.es.js -o packages/dashboard/public/public/dittofeed.es.js

COPY ./packages/backend-lib/ ./packages/backend-lib
COPY ./packages/isomorphic-lib/ ./packages/isomorphic-lib
COPY ./packages/api/ ./packages/api
COPY ./packages/worker/ ./packages/worker
COPY ./packages/admin-cli/ ./packages/admin-cli
COPY ./packages/emailo/ ./packages/emailo

# Dashboard changes must not invalidate the backend compilation layer.
RUN yarn workspace emailo build && \
    yarn workspace api build && \
    yarn workspace worker build && \
    yarn workspace admin-cli build

# Keep public assets out of compilation inputs; Next serves them at runtime.
COPY ./packages/dashboard/*.json ./packages/dashboard/
COPY ./packages/dashboard/next.config.js ./packages/dashboard/next-env.d.ts ./packages/dashboard/
COPY ./packages/dashboard/src ./packages/dashboard/src
COPY ./packages/dashboard/scripts ./packages/dashboard/scripts
# Lite embeds Next in its custom server and already ships production dependencies.
RUN NEXT_STANDALONE=false yarn workspace dashboard build && \
    rm -rf packages/dashboard/.next/cache

COPY ./packages/lite/ ./packages/lite
# Project references also emit dashboard/dist, which Lite needs at runtime.
RUN yarn workspace lite build

# Static-only releases reuse every compilation layer, including Lite's.
COPY ./packages/dashboard/public ./packages/dashboard/public

# Production image
FROM node:24.21.0-trixie-slim AS runner

WORKDIR /service

RUN yarn set version 4.1.1

COPY --from=builder /service/production_node_modules ./node_modules
COPY --from=builder /service/package.json ./package.json
COPY --from=builder /service/*.json /service/yarn.lock /service/.yarnrc.yml ./
COPY --from=builder /service/.yarn .yarn

COPY --from=builder /service/packages/lite/dist ./packages/lite/dist
COPY --from=builder /service/packages/lite/package.json ./packages/lite/package.json

COPY --from=builder /service/packages/emailo/dist ./packages/emailo/dist
COPY --from=builder /service/packages/emailo/package.json ./packages/emailo/package.json

COPY --from=builder /service/packages/api/dist ./packages/api/dist
COPY --from=builder /service/packages/api/package.json ./packages/api/package.json

COPY --from=builder /service/packages/worker/dist ./packages/worker/dist
COPY --from=builder /service/packages/worker/package.json ./packages/worker/package.json

COPY --from=builder /service/packages/admin-cli/dist ./packages/admin-cli/dist
COPY --from=builder /service/packages/admin-cli/package.json ./packages/admin-cli/package.json

COPY --from=builder /service/packages/backend-lib/dist ./packages/backend-lib/dist
COPY --from=builder /service/packages/backend-lib/drizzle ./packages/backend-lib/drizzle
COPY --from=builder /service/packages/backend-lib/package.json ./packages/backend-lib/package.json

COPY --from=builder /service/packages/isomorphic-lib/dist ./packages/isomorphic-lib/dist
COPY --from=builder /service/packages/isomorphic-lib/package.json ./packages/isomorphic-lib/package.json

COPY --from=builder /service/packages/dashboard/dist ./packages/dashboard/dist
COPY --from=builder /service/packages/dashboard/.next ./packages/dashboard/.next
COPY --from=builder /service/packages/dashboard/public ./packages/dashboard/public
COPY --from=builder /service/packages/dashboard/next.config.js ./packages/dashboard/next.config.js
COPY --from=builder /service/packages/dashboard/package.json ./packages/dashboard/package.json

# Release metadata belongs after all installation and compilation layers.
ARG APP_VERSION
ARG WORKSPACE_NAME='Default'

ENV NODE_ENV=production \
    PRE_BUILT=true \
    AUTH_MODE='single-tenant' \
    WORKSPACE_NAME=${WORKSPACE_NAME} \
    APP_VERSION=${APP_VERSION}

EXPOSE 3000

CMD node ./packages/lite/dist/scripts/startLite.js --workspace-name=${WORKSPACE_NAME}
