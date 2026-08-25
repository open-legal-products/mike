FROM node:22-slim

# LOCAL PATCH (not upstream): built from the REPO ROOT context, not ./frontend.
# frontend/src/app/components/shared/types.ts imports backend types through
# ../../../../../backend/src/lib/..., which only resolves when both packages sit
# side by side. Keeping /app/frontend + /app/backend makes those paths real, so
# next build type-checks instead of degrading the imports to `any`.
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY backend/ /app/backend/

RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
