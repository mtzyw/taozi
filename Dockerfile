FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY admin-web ./admin-web
COPY miniprogram ./miniprogram
COPY scripts ./scripts

EXPOSE 3000
CMD ["npm", "run", "start"]
