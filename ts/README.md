# WaHooWest TypeScript Project

## Project Structure

```
ts/
├── package.json
├── tsconfig.server.json       # Server TypeScript config
├── tsconfig.client.json       # Client TypeScript config
├── shared/
│   └── protocols.ts           # Shared protocol types
├── server/
│   ├── .env                   # Snowflake credentials
│   └── src/
│       ├── main.ts            # WebSocket game server
│       └── room.ts            # Room / Snowflake logic
├── client/
│   ├── src/
│   │   ├── index.html         # HTML shell
│   │   ├── main.ts            # Client entry point
│   │   ├── game.ts            # Canvas-based game UI
│   │   ├── client.ts          # WebSocket client
│   │   └── auth.ts            # Auth0 device-code flow
│   └── images/                # Game assets (PNG files)
└── dist/                      # Compiled output
    ├── server/
    └── client/
```

## Setup

```bash
cd ts
npm install
```

## Running

### Start the server
```bash
npm run dev:server
# or: npm run build:server && npm run start:server
```

### Start the client
```bash
npm run build:client
npm run dev:client
# Then open http://localhost:8080 in your browser
```

## How It Works

This is a TypeScript port of the Python/Pygame WaHooWest quiz game.

- **Server**: Node.js WebSocket server (port 64210) using the `ws` library.
  Manages per-subject matchmaking, loads questions from Snowflake,
  downloads question images from Snowflake stage, and orchestrates
  the quiz flow.

- **Client**: Browser-based HTML5 Canvas app.
  Connects to the server via native WebSocket. Renders all game
  screens (home, login, subject selection, character selection,
  waiting, quiz, end) on a `<canvas>` element.

- **Auth**: Auth0 device-code flow. The browser opens a new tab for
  login, polls for the token, then sends the user's nickname to
  the server.

## Environment Variables

### Server (`server/.env`)
- `SNOW_USER` – Snowflake username
- `SNOW_ACCOUNT` – Snowflake account
- `SNOW_PASSWORD` – Snowflake password
- `SNOW_WAREHOUSE` – Snowflake warehouse
- `SNOW_DATABASE` – Snowflake database
- `SNOW_SCHEMA` – Snowflake schema
- `SNOW_TABLES` – Comma-separated table names

### Client (set in `index.html` or defaults in `game.ts`)
- `AUTH0_DOMAIN` – Auth0 domain
- `AUTH0_CLIENT_ID` – Auth0 client ID
- `AUTH0_AUDIENCE` – Auth0 API audience
- `SERVER_HOST` – WebSocket server host
- `SERVER_PORT` – WebSocket server port
