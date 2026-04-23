# Build stage
FROM golang:1.21-alpine AS builder

WORKDIR /app

COPY go.mod main.go ./
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o messenger main.go

# Runtime stage
FROM alpine:latest

WORKDIR /app

COPY --from=builder /app/messenger .

EXPOSE 8080

CMD ["./messenger"]
