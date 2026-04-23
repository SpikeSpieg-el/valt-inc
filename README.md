# Valt Inc - Encrypted Messenger

Dockerized encrypted messenger application with PostgreSQL and Redis.

## Environment Setup

### Local Development

```bash
# Using default docker-compose.yml
docker-compose up -d

# Or explicitly using dev configuration
docker-compose -f docker-compose.dev.yml up -d
```

### Production

```bash
# Using production configuration
docker-compose -f docker-compose.prod.yml up -d
```

## Environment Variables

Create `.env` file based on environment:

- `.env.dev` - Development environment (default)
- `.env.prod` - Production environment

Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
```

## Services

- **App**: Go backend on port 3005 (container: 8080)
- **PostgreSQL**: Database on port 5433 (dev) / 5432 (prod)
- **Redis**: Cache/message broker on port 6379

## Endpoints

- `/socket.io` - WebSocket connection
- `/api/register` - User registration

## Database Initialization

The `init.sql` file is automatically executed on PostgreSQL startup to create:
- `users` table - Stores user public keys
- `offline_messages` table - Stores messages for offline users

## Stopping Services

```bash
docker-compose down

# For production
docker-compose -f docker-compose.prod.yml down
```

## Viewing Logs

```bash
docker-compose logs -f

# Specific service
docker-compose logs -f app
docker-compose logs -f postgres
docker-compose logs -f redis
```

## Rebuilding

```bash
docker-compose up -d --build
```
