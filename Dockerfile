# cutiemail — a from-scratch mail server with ZERO runtime dependencies.
#
# There is no build step and nothing to install: Node runs the .ts files directly (type
# stripping, ≥ 22.18), and node_modules holds only the type-checker, which the runtime does
# not need. So this image is just "the official Node runtime + the source" — no `npm install`,
# no compile, no multi-stage dance. That smallness is the point (ADR 0020).
FROM node:22-slim

# Run as the unprivileged `node` user the base image ships (uid 1000). The container binds
# high ports (see compose) and maps them, so no privileged-port capability is needed inside.
WORKDIR /app
COPY --chown=node:node src ./src
COPY --chown=node:node package.json ./

# State lives on a mounted volume, not in the image. MAIL_CONTROL_DB points here; the per-user
# mail-<login>.db files are created beside it. Owner-only, matching the daemon's own hardening.
RUN mkdir -p /data && chown node:node /data
USER node
ENV MAIL_CONTROL_DB=/data/control.db

# Default to loopback-safe dev config; compose (or `-e`) overrides MAIL_HOST/ports/TLS/domain.
# The daemon refuses to serve the bundled dev certificate on a non-loopback bind, so a real
# deployment MUST mount a certificate and set MAIL_TLS_CERT/MAIL_TLS_KEY (see compose comments).
ENV MAIL_HOST=0.0.0.0

# inbound SMTP · submission (STARTTLS+AUTH) · IMAPS — the in-container ports (remap on the host).
EXPOSE 2525 5587 5993
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
