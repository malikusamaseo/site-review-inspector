FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
ENV PORT=4000 DATA_DIR=/data
VOLUME /data
EXPOSE 4000
CMD ["node", "server.js"]
