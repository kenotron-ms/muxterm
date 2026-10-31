FROM golang:1.24-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /poc .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 1000 poc
COPY --from=builder /poc /usr/local/bin/google-ssh-poc
USER poc
ENTRYPOINT ["google-ssh-poc"]
