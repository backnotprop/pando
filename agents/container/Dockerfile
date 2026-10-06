# The agent's sandbox: git, node, ripgrep, and pando with the ArtifactFS fork,
# so the session's branch mounts through FUSE the way it does on any Linux
# machine (stage 0, BUILD-NOTES.md).
#
# Build context: projects/pando (wrangler.jsonc, build_context ".."): pando
# is built from cli/. The fork is fetched from GitHub at a pinned commit;
# move AFS_COMMIT when the fork's main moves.

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
ARG AFS_COMMIT=0cfd59cad8f6a7783bc4605ef0eac85c9d07cf8b
RUN git clone -q https://github.com/backnotprop/artifact-fs /afs && git -C /afs checkout -q "$AFS_COMMIT"
WORKDIR /afs
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -o /out/artifact-fs ./cmd/artifact-fs
WORKDIR /src
COPY cli/go.mod cli/go.sum ./
RUN go mod download
COPY cli/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -o /out/pando ./cmd/pando

FROM node:24-trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates curl fuse3 git procps ripgrep util-linux \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build /out/artifact-fs /out/pando /usr/local/bin/
COPY --chmod=0755 agents/container/workspace.sh /usr/local/bin/pando-agent-workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
