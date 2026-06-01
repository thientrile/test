FROM node:26-alpine

WORKDIR /app

# Install deps first for layer caching.
# --ignore-scripts: don't run our own lifecycle scripts during the
# install layer (the source they reference hasn't been COPY'd yet).
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# Bring in the rest of the source
COPY . .

# Make artillery + node binaries available
ENV PATH=/app/node_modules/.bin:$PATH

# Default to a no-op; docker-compose overrides per service
CMD ["node", "--version"]
