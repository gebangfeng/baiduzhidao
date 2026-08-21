FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.cjs ./
COPY admin ./admin
ENV LICENSE_DATA_DIR=/data
ENV HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8787
CMD ["npm", "start"]
