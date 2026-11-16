# An owned model-free checker. Build explicitly; the collector never builds or pulls.
FROM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
LABEL org.aboiteau.check.profile="committed-offline-v1"
WORKDIR /opt/aboiteau-check
COPY runtime/check/bootstrap.ts ./runtime/check/bootstrap.ts
COPY src/workspace-check-snapshot.ts src/workspace-repository.ts ./src/
RUN printf '[install]\nauto = "disable"\n' > bunfig.toml
ENV PATH=/usr/local/bin:/usr/bin:/bin BUN_OPTIONS=""
USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/bun", "--no-env-file", "--no-install", "--config=/opt/aboiteau-check/bunfig.toml", "/opt/aboiteau-check/runtime/check/bootstrap.ts"]
CMD []
