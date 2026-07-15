# Minimal image for the Nervous System MCP server (stdio transport).
# Glama's check only needs the server to start and answer introspection.
FROM node:20-alpine

WORKDIR /app

# Install production deps first so the layer caches.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Only the files the package actually ships (see "files" in package.json).
COPY stdio.js ./
COPY lib ./lib
COPY nervous-system.config.example.json ./
COPY README.md LICENSE ./

# stdio transport: the MCP client speaks JSON-RPC over stdin/stdout.
ENTRYPOINT ["node", "stdio.js"]
