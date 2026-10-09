FROM node:20-alpine

WORKDIR /app

# Copy package definition first for Docker build layer caching
COPY package.json ./

# Install production dependencies cleanly without audit delays
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source code
COPY . .

# Set default production environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
