FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# Background playback processing normalizes uploaded codecs and creates HLS
# segments so viewers do not need to download the full original MP4 first.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY server.js database.js bunny.js transcoder.js ip-country.js ./
COPY public ./public

RUN mkdir -p /app/data /app/temp
EXPOSE 3000
CMD ["node", "server.js"]
