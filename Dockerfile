FROM node:20-bookworm-slim

# Install latest Chromium and required fonts for Puppeteer PDF rendering
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the installed system Chromium package
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy project files
COPY . .

# Ensure output and my_cvs directories exist
RUN mkdir -p output my_cvs

# Verify production readiness
RUN npm run build

EXPOSE 3000

CMD ["node", "server.js"]
