# syntax=docker/dockerfile:1

ARG POCKETBASE_VERSION=0.40.4

FROM golang:1.22-alpine AS collector
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /syncms-collector ./cmd/collector

FROM alpine:3.21
ARG POCKETBASE_VERSION
ARG VERSION=dev
ARG COMMIT=none
ARG BUILDTIME=unknown

ENV SYNCMS_VERSION=${VERSION} \
    SYNCMS_COMMIT=${COMMIT} \
    SYNCMS_BUILD_TIME=${BUILDTIME} \
    SYNCMS_PB_URL=http://127.0.0.1:8090 \
    SYNCMS_SAMPLE_INTERVAL_SEC=60 \
    SYNCMS_RETENTION_DAYS=45

RUN apk add --no-cache ca-certificates curl unzip tini \
    && addgroup -S syncms \
    && adduser -S syncms -G syncms

WORKDIR /app

RUN curl -fsSL \
    "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_amd64.zip" \
    -o /tmp/pocketbase.zip \
    && unzip /tmp/pocketbase.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/pocketbase \
    && rm /tmp/pocketbase.zip

COPY --from=collector /syncms-collector /usr/local/bin/syncms-collector
COPY pb_migrations/ ./pb_migrations/
COPY web/ ./pb_public/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p pb_data \
    && chown -R syncms:syncms /app

USER syncms

EXPOSE 8090

VOLUME ["/app/pb_data"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
