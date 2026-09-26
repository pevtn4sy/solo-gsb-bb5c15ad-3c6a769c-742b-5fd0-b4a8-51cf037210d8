FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV PORT=3000
ENV DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]
