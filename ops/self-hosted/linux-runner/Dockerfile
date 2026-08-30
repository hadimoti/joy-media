FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

ARG RUNNER_VERSION=2.337.0
ARG RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
ARG NODE_VERSION=22.14.0
ARG NODE_SHA256=69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z
ARG MC_SHA256=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891

ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_ALLOW_RUNASROOT=0 \
    COREPACK_HOME=/opt/corepack \
    PATH=/opt/actions-runner/bin:/opt/node/bin:$PATH

RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    ca-certificates curl git jq unzip tar gzip xz-utils ffmpeg postgresql-client \
    python3 make g++ libicu-dev libssl-dev libkrb5-3 zlib1g libstdc++6 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1001 --shell /usr/sbin/nologin joyci \
  && mkdir -p /opt/actions-runner /opt/node /opt/corepack \
  && curl --fail --silent --show-error --location \
       "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
       --output /tmp/actions-runner.tar.gz \
  && echo "${RUNNER_SHA256}  /tmp/actions-runner.tar.gz" | sha256sum --check --strict \
  && tar -xzf /tmp/actions-runner.tar.gz -C /opt/actions-runner \
  && rm /tmp/actions-runner.tar.gz \
  && curl --fail --silent --show-error --location \
       "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
       --output /tmp/node.tar.xz \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum --check --strict \
  && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node \
  && rm /tmp/node.tar.xz \
  && /opt/node/bin/corepack enable \
  && COREPACK_HOME=/opt/corepack /opt/node/bin/corepack install --global pnpm@11.15.0 \
  && curl --fail --silent --show-error --location \
       "https://github.com/minio/mc/releases/download/${MC_VERSION}/mc.linux-amd64.${MC_VERSION}" \
       --output /usr/local/bin/mc \
  && echo "${MC_SHA256}  /usr/local/bin/mc" | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/mc \
  && chown -R joyci:joyci /opt/actions-runner /opt/node /opt/corepack /home/joyci \
  && chmod -R a+rX /opt/corepack

COPY --chmod=755 entrypoint.sh /usr/local/bin/joy-media-linux-runner

USER joyci
WORKDIR /opt/actions-runner
ENTRYPOINT ["/usr/local/bin/joy-media-linux-runner"]
