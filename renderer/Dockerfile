FROM node:22@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2 AS builder

WORKDIR /build
COPY package*.json tsconfig.json ./
COPY src ./src
# Install all deps (incl. devDeps like typescript) so `npm run build` (tsc) works,
# build to dist/, then drop devDeps so only runtime deps are copied forward.
RUN npm ci && npm run build && npm prune --omit=dev

# runtime stage
FROM node:22@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chrome that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-ipafont-gothic fonts-wqy-zenhei \
    fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf ca-certificates libnss3 \
    libgtk-3-0 libdrm2 fonts-liberation libasound2 libgbm1 libvulkan1 xdg-utils libxss1 \
    libgconf-2-4 libxtst6 libxrandr2 libatk1.0-0 libgtk-3-0 libgdk-pixbuf2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# create user
RUN usermod -d /home/renderer -l renderer node && \
    groupmod -n renderer node && \
    rm -rf /home/node && \
    mkdir -p /home/renderer/service && \
    mkdir -p /home/renderer/.cache/puppeteer && \
    chown -R renderer:renderer /home/renderer

# set workdir
WORKDIR /home/renderer/service

# copy built app from builder stage
COPY --from=builder --chown=renderer:renderer /build/dist ./dist
COPY --from=builder --chown=renderer:renderer /build/node_modules ./node_modules
COPY --chown=renderer:renderer package*.json ./

# install browser
ENV PUPPETEER_CACHE_DIR=/home/renderer/.cache/puppeteer
RUN npm run install-browser
RUN chown -R renderer:renderer /home/renderer

# Switch user
USER root

# Configure default locale (important for chrome-headless-shell).
ENV LANG=en_US.UTF-8

# Define build-time args
ARG HDB_HOST
ARG HDB_MQTT_PORT
ARG HDB_HTTP_PORT
ARG HDB_USER
ARG HDB_PASS
ARG WORKER_ID

# Map to runtime env
ENV HDB_HOST=${HDB_HOST} \
    HDB_MQTT_PORT=${HDB_MQTT_PORT} \
    HDB_HTTP_PORT=${HDB_HTTP_PORT} \
    HDB_USER=${HDB_USER} \
    HDB_PASS=${HDB_PASS} \
    WORKER_ID=${WORKER_ID}

CMD [ "node", "dist/index.js" ]
