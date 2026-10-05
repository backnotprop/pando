# Stage 0 spike: the agent's sandbox with pando and the ArtifactFS fork, so a
# worktree mounts through FUSE the way it does on any Linux machine.
# Build context: projects/pando's cli/ (wrangler.jsonc, build_context).
# The fork is fetched at a pinned commit of backnotprop/artifact-fs (public).

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
ARG AFS_COMMIT=0cfd59cad8f6a7783bc4605ef0eac85c9d07cf8b
RUN git clone -q https://github.com/backnotprop/artifact-fs /afs && git -C /afs checkout -q "$AFS_COMMIT"
WORKDIR /afs
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -o /out/artifact-fs ./cmd/artifact-fs
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -o /out/pando ./cmd/pando

FROM node:24-trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl fuse3 git procps ripgrep util-linux \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build /out/artifact-fs /out/pando /usr/local/bin/
WORKDIR /workspace
CMD ["sleep", "infinity"]
