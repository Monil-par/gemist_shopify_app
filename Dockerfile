FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Install all deps (including build tools like vite), then prune after build
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

COPY . .

# prisma generate does not need a live database.
# migrate deploy must run at container start (see CMD), when db is reachable.
ENV DATABASE_URL="postgresql://gemist:gemist@127.0.0.1:5432/gemist?schema=public"
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Compose supplies real DATABASE_URL via env_file (.env.production).
# Migrate when the container starts, then boot the app.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
