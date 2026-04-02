FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o sidjua-updater .

FROM alpine:3.21
RUN apk add --no-cache docker-cli curl
COPY --from=builder /build/sidjua-updater /usr/local/bin/
EXPOSE 8090
USER 1000:1000
ENTRYPOINT ["sidjua-updater"]
