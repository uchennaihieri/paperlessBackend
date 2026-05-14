FROM node:20-alpine

WORKDIR /app

# Install system dependencies (needed for Prisma on Alpine)
RUN apk add --no-cache openssl libc6-compat

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm install

# Copy full project (INCLUDING prisma schema)
COPY . .

# Generate Prisma client AFTER schema is available
RUN npx prisma generate

EXPOSE 5000

CMD ["npm", "start"]
