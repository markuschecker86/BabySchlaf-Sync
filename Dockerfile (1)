FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY server.js .
RUN mkdir -p data
ENV DB_PATH=/app/data/babyschlaf.db
EXPOSE 3000
CMD ["node", "server.js"]
