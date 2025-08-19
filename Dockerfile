# Node 20 LTS
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Cloud Run/App Runner가 PORT 환경변수를 주입하므로 그대로 사용
ENV NODE_ENV=production
EXPOSE 8080

# 헬스체크/엔드포인트: /health, /sse, /messages
CMD ["node", "src/server.js"]
