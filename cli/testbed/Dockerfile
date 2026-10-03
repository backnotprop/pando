# syntax=docker/dockerfile:1
# The Linux test bed: fuse3, git, the ArtifactFS fork's artifact-fs, and pando.
# Built by testbed/run.sh with the fork as the build context "afs-src".

FROM golang:1.26-bookworm AS afs
WORKDIR /src
COPY --from=afs-src go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY --from=afs-src . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/artifact-fs ./cmd/artifact-fs

FROM golang:1.26-bookworm AS pando
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -o /out/pando ./cmd/pando

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      fuse3 git ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*
COPY --from=afs /out/artifact-fs /usr/local/bin/artifact-fs
COPY --from=pando /out/pando /usr/local/bin/pando
COPY --chmod=0755 testbed/e2e.sh /testbed/e2e.sh
ENV PANDO_MACHINE=linux-testbed
WORKDIR /work
CMD ["/testbed/e2e.sh"]
