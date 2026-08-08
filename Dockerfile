# Single stage: there is nothing to build. The server is plain Node and the
# reader is plain JS/CSS — cheerio is the only runtime dependency.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8208

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

# Pre-built books, keyed (title, revision, template version). Dropping them into
# the cache directory means the showcase articles render instantly on a cold
# machine instead of spending ~10s rebuilding them from the Wikimedia APIs.
# A cache miss (article edited since) just falls through to a live build.
COPY seed/books/ ./.cache/books/

EXPOSE 8208
CMD ["node", "server.js"]
