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

## Architecture & Stack Flow

### Components

- **Frontend**: Static files (HTML/JS/CSS) hosted on GitHub Pages (`spikespieg-el.github.io`)
- **Caddy Reverse Proxy**: Handles HTTPS on port 443, proxies requests to backend
- **Go Backend**: REST API + WebSocket server in Docker on port 3005
- **PostgreSQL**: User data, contacts, offline messages
- **Redis**: Pub/sub for real-time message delivery

### Request Flow

```
User Browser (GitHub Pages)
    ↓ HTTPS (port 443)
Caddy (vault-inc.duckdns.org)
    ↓ Proxy
    ├─ /api/* → Go Backend (port 3005)
    ├─ /socket.io* → Go Backend (port 3005)
    └─ /* → Static files (dist/)
```

### How It Works

1. **Frontend** calls `https://vault-inc.duckdns.org/api/*` (no port specified)
2. **Caddy** receives HTTPS on port 443, terminates SSL
3. **Caddy** proxies `/api/*` requests to Go backend on `127.0.0.1:3005`
4. **Go backend** processes requests:
   - REST API endpoints for auth, user data, contacts
   - WebSocket endpoint for real-time messaging
5. **PostgreSQL** stores users, contacts, offline messages
6. **Redis** pub/sub delivers messages to online users in real-time

### Important Notes

- Frontend NEVER connects directly to port 3005
- All traffic goes through Caddy (HTTPS on 443)
- Go backend runs HTTP (no SSL) internally on port 3005
- Caddy handles SSL certificates automatically via Let's Encrypt

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
