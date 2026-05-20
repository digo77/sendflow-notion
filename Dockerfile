FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
# cache-bust: 2026-05-20
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]
