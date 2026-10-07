# syntax=docker/dockerfile:1
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; go mod download
COPY main.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /artifact-share .
RUN mkdir /data && chown 65532:65532 /data
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /artifact-share /artifact-share
COPY --from=build --chown=65532:65532 /data /data
WORKDIR /data
ENV PORT=8080 DATABASE_URL=file:/data/artifacts.db
EXPOSE 8080
ENTRYPOINT ["/artifact-share"]
