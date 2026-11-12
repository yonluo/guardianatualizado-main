FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /recordings \
    && chown -R node:node /app

USER node
EXPOSE 4000

CMD ["node", "server.js"]
