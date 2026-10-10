# Bookify — container image for the Express app (website + /api).
# Lives at the repository root so deploy tools find it; the app itself is in
# Bookify-prototype/. Build from the repository root:  docker build -t bookify .
# The database is NOT inside this container: it connects to MySQL (Aiven)
# using the DB_* environment variables set on the hosting platform.

# Node.js 22 LTS. package.json requires Node 22 or newer (Node 20 is end-of-life).
FROM node:22-alpine

# Set the working directory inside the container
WORKDIR /app

# Production mode: smaller install, and the login cookie is sent only over https
ENV NODE_ENV=production

# Copy package files first and install dependencies, so Docker can reuse this
# layer when only the app code changes. `npm ci` installs exactly what
# package-lock.json says; --omit=dev skips development-only packages.
COPY Bookify-prototype/package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code (.dockerignore keeps out node_modules,
# .env, passwords and certificates)
COPY Bookify-prototype/ ./

# Run as the unprivileged "node" user instead of root
USER node

# The port the app listens on. Platforms may set their own PORT; server.js uses it.
ENV PORT=3000
EXPOSE 3000

# Lets Docker / the platform see whether the app can still reach the database
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

# Start the application
CMD ["node", "server.js"]
