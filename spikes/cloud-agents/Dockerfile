FROM node:24-trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*
RUN git config --system user.name "Pando cloud agent" && git config --system user.email "agent@pando.invalid"
WORKDIR /workspace
CMD ["sleep", "infinity"]
