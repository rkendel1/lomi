# Lomi application image: API, worker, migrate and seed all run from this image.
# Debian trixie (glibc 2.41): the native Node binding needs glibc and the ml-runtime CLI needs glibc >= 2.39.
FROM node:22-trixie-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Install against the workspace manifests first so dependency layers cache well.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/pdf/package.json packages/pdf/package.json
COPY packages/docops/package.json packages/docops/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# Optional: trust an extra CA (e.g. a TLS-intercepting corporate proxy) via `--secret id=extra_ca,src=ca.pem`.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @lomi/api... build

FROM node:22-trixie-slim AS runtime
# Pinned rust-ml-runtime CLI, used only to install/verify local models (`ml-runtime model install laya`).
COPY apps/api/docker/install-ml-runtime.mjs /tmp/install-ml-runtime.mjs
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    NODE_USE_ENV_PROXY=1 node /tmp/install-ml-runtime.mjs && rm /tmp/install-ml-runtime.mjs && ml-runtime --version
ENV NODE_ENV=production
ENV PORT=4000
ENV ML_RUNTIME_MODEL_DIR=/models
ENV LOMI_STORAGE_DIR=/data/objects
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
RUN mkdir -p /models /data/objects && chown -R node:node /models /data /repo/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
