# ROBOT (OBO tool for reasoning, quality reports and profile validation), pinned version,
# so ontology consistency can be checked locally without installing Java.
#   docker build -t schemascope/robot docker/robot
#   docker run --rm -v "$PWD:/work" schemascope/robot reason --input /work/ontology.owl --reasoner ELK
FROM eclipse-temurin:17-jre
ARG ROBOT_VERSION=v1.9.7
ADD https://github.com/ontodev/robot/releases/download/${ROBOT_VERSION}/robot.jar /opt/robot/robot.jar
LABEL org.opencontainers.image.title="ROBOT for SchemaScope" org.opencontainers.image.source="https://github.com/ontodev/robot"
WORKDIR /work
ENTRYPOINT ["java", "-Xmx6g", "-jar", "/opt/robot/robot.jar"]
