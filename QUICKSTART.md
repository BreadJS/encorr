# Encorr - Quick Start Guide

## Installation

```bash
cd C:/Users/cuper/OneDrive/Bureaublad/Encorr
npm install
```

## Building

```bash
npm run build
```

## Running the Application

### 1. Start the Server

```bash
npm run dev:server
```

The server will start on:
- **Web UI**: http://localhost:8100
- **API**: http://localhost:8101/api
- **WebSocket**: ws://localhost:8101/ws

### 2. Start a Transcoding Node (New Terminal)

```bash
npm run dev:node
```

Or build and run the CLI directly:

```bash
npm run build:node
node packages/node/dist/cli/index.js start --server ws://localhost:8101 --name "My Node" --cache ./cache
```

## First Time Setup

1. **Install HandBrakeCLI** (required for transcoding):
   - Windows: Download from https://handbrake.fr/downloads.php
   - The node will auto-detect HandBrakeCLI location

2. **Start the server** - It will create the database automatically

3. **Start a node** - It will register with the server automatically

4. **Open the Web UI** at http://localhost:8100

5. **Configure folder mappings**:
   - Go to the Mappings page
   - Add a folder mapping (server path to node path)
   - Enable "Watch" to auto-discover files

6. **Create transcoding jobs**:
   - Go to the Files page to see discovered files
   - Select files and choose a preset
   - Jobs will be queued and processed by available nodes

## CLI Commands

### Node Commands

```bash
# Start a node
encorr-node start --server ws://localhost:8101 --name "My Node" --cache ./cache

# Check status
encorr-node status

# Test HandBrake installation
encorr-node test-handbrake

# Show help
encorr-node --help
```

### Server Commands

```bash
# Start server (API + Web UI)
npm run dev:server

# Start only Web UI
npm run dev:web

# Build for production
npm run build:server
```

## Built-in Presets

1. **High Quality (H.265)** - Best quality with H.265 encoding
2. **Maximum Compression** - Smallest file size with 1080p cap
3. **Quick Convert** - Fast encoding with H.264
4. **MKV to MP4** - Container only, no quality loss

## Project Structure

```
encorr/
├── packages/
│   ├── server/          # Web GUI + Backend API + WebSocket
│   │   ├── src/
│   │   │   ├── api/     # REST API endpoints
│   │   │   ├── websocket/  # WebSocket server
│   │   │   ├── database/    # SQLite operations
│   │   │   ├── web/         # Frontend (React)
│   │   │   └── index.ts     # Server entry point
│   │   └── package.json
│   │
│   ├── node/            # Transcoding Node (CLI)
│   │   ├── src/
│   │   │   ├── cli/         # CLI interface
│   │   │   ├── client/      # WebSocket client
│   │   │   ├── worker/      # Transcoding worker
│   │   │   └── handbrake/   # HandBrake integration
│   │   └── package.json
│   │
│   └── shared/          # Shared types and utilities
│       └── src/
│           ├── types/       # TypeScript types
│           ├── messages/    # WebSocket message types
│           └── config/      # Configuration utilities
│
├── package.json
└── README.md
```

## Troubleshooting

### HandBrake Not Found

If you see "HandBrakeCLI not found":
1. Download and install HandBrake from https://handbrake.fr/downloads.php
2. Or use the `--handbrake` option to specify the path:
   ```bash
   encorr-node start --handbrake "C:/Program Files/HandBrake/HandBrakeCLI.exe"
   ```

### Port Already in Use

If port 3000 is already in use, set a different port:
```bash
ENCORR_PORT=3001 npm run dev:server
```

### Database Issues

The database is created at `~/.encorr/server/encorr.db`. If you have issues:
1. Stop the server
2. Delete the database file
3. Restart the server (it will recreate the database)

## Features

- **Real-time progress updates** via WebSocket
- **Multi-node support** - Run multiple transcoding nodes
- **Queue management** - Jobs are automatically distributed to available nodes
- **Built-in presets** - Common transcoding configurations
- **Custom presets** - Create your own encoding profiles
- **Folder watching** - Auto-discover video files
- **Web UI** - User-friendly dashboard

## Requirements

- Node.js 20+
- HandBrake CLI (for transcoding nodes)
- Windows, Linux, or macOS
