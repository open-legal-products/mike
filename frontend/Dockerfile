# Build from the repository root; shared wire declarations live in packages/contracts.
FROM node:22-slim

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY packages/contracts /packages/contracts
COPY word-addin/src /word-addin/src

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
