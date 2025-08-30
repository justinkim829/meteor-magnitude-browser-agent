FROM node:18-slim

# Install dependencies for Chrome/Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy all files needed for the monorepo structure
COPY package*.json ./
COPY turbo.json ./
COPY .npmrc ./
COPY packages ./packages/

# Install dependencies (this will also run postinstall which builds)
RUN npm install --force

# Copy app source
COPY magnitude_mcp_server_new_tab.js ./
COPY magnitude_mcp_server.js ./
COPY services ./services

# Create .env file placeholder
RUN touch .env

# Expose ports
# 9123 - MCP server port
EXPOSE 9123

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9123/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); });"

# Security: Run as non-root user
RUN useradd -m -s /bin/bash mcpuser && chown -R mcpuser:mcpuser /app
USER mcpuser

# Start the server
CMD ["node", "magnitude_mcp_server_new_tab.js"]