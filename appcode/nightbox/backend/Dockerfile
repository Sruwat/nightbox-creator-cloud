FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js database.js bunny.js ./
COPY public ./public

RUN mkdir -p /app/data /app/temp
EXPOSE 3000
CMD ["node", "server.js"]
