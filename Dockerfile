FROM node:20-alpine

WORKDIR /app

# System deps (important for Prisma + Puppeteer)
RUN apk add --no-cache openssl libc6-compat

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy full source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# BUILD TYPESCRIPT
RUN npm run build

EXPOSE 5000

CMD ["npm", "start"]
