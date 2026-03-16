# Encorr

A user-friendly video transcoding application designed to save storage space by converting video files.

## Quick Start

### Installation

```bash
npm install
npm run build
```

### Starting the Server

```bash
npm run dev:server
```

The server will start on http://localhost:8100

### Starting a Node

```bash
npm run dev:node
```

Or build and use the CLI directly:

```bash
npm run build:node
node packages/node/dist/cli/index.js start --server ws://localhost:8100 --name "My Node" --cache ./cache
```

## Architecture

- **Server**: Web GUI + Backend API + WebSocket server + SQLite database
- **Node**: CLI application that performs actual transcoding using HandBrake CLI
- **Communication**: WebSocket for real-time bidirectional communication

## Requirements

- Node.js 20+
- HandBrake CLI (for transcoding nodes)

## Project Structure

```
encorr/
├── packages/
│   ├── server/          # Web GUI + Backend API
│   ├── node/            # Transcoding Node (CLI)
│   └── shared/          # Shared types and utilities
└── package.json         # Monorepo root
```

## License

MIT
