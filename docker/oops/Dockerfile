# OOPS! (OntOlogy Pitfall Scanner) command-line, built from source at a pinned commit,
# so SchemaScope can scan ontologies without depending on https://oops.linkeddata.es.
#   docker build -t schemascope/oops docker/oops
#   docker run --rm -v "$PWD/work:/work" schemascope/oops --input-file /work/ontology.owl
# The pitfall report is written to /work/tstOut.model.ttl (Turtle, OOPS! vocabulary).

FROM maven:3.9-eclipse-temurin-17 AS build
ARG OOPS_COMMIT=11572ea6b31cba29dd3f8a443e24311652f059de
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/oeg-upm/OOPS.git \
 && git fetch -q --depth 1 origin "$OOPS_COMMIT" && git checkout -q FETCH_HEAD
RUN mvn -q -B -Dmaven.test.skip=true -Dmaven.javadoc.skip=true -Dmaven.source.skip=true compile dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=target/lib

FROM eclipse-temurin:17-jre
LABEL org.opencontainers.image.title="OOPS! CLI for SchemaScope" \
      org.opencontainers.image.source="https://github.com/oeg-upm/OOPS" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /src/target/classes /opt/oops/classes
COPY --from=build /src/target/lib /opt/oops/lib
WORKDIR /work
ENV JAVA_TOOL_OPTIONS="-Xmx4g"
ENTRYPOINT ["java", "-cp", "/opt/oops/classes:/opt/oops/lib/*", "es.upm.fi.oeg.oops.Cli"]
