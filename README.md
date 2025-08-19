# OpenAI TTS Remote MCP Server

원격으로 사용할 수 있는 OpenAI Text-to-Speech MCP 서버입니다. 

## 🚀 서버 설정

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경변수 설정
`.env` 파일을 생성하고 다음 내용을 설정하세요:

```bash
# OpenAI API 키
OPENAI_API_KEY=your-openai-api-key-here

# 서버 포트
PORT=8080

# 인증 토큰 (직원들과 공유할 토큰)
AUTH_TOKEN=your-secret-token-here
```

### 3. 서버 실행
```bash
npm start
```

### 4. 방화벽 설정
포트 8080을 인바운드 규칙에 추가하세요.

## 👥 직원 설정 (Claude Desktop)

각 직원이 자신의 Claude Desktop에서 다음과 같이 설정합니다:

### 1. Claude Desktop 열기
Claude Desktop → **Settings** → **Connectors**

### 2. Custom Connector 추가
- **Add Custom Connector** 클릭
- **Name**: OpenAI TTS
- **URL**: `http://YOUR_SERVER_IP:8080/sse`
- **Headers**: 
  - Key: `Authorization`
  - Value: `Bearer tts-mcp-token-2025`

### 3. 연결 테스트
Claude에서 다음과 같이 테스트:
- "안녕하세요를 음성으로 변환해주세요"
- "Hello world를 nova 음성으로 변환해주세요"

## 🔧 서버 관리

### 헬스 체크
```bash
curl http://YOUR_SERVER_IP:8080/health
```

### 서버 정보 확인
```bash
curl http://YOUR_SERVER_IP:8080/
```

### 생성된 오디오 파일 확인
브라우저에서: `http://YOUR_SERVER_IP:8080/audio/`

## 🔒 보안

- **인증 토큰**: 모든 요청에 Bearer 토큰이 필요합니다
- **HTTPS 권장**: 프로덕션에서는 리버스 프록시(Nginx)로 HTTPS 설정
- **방화벽**: 필요한 IP만 허용하도록 설정

## 🛠️ 고급 설정

### Nginx 리버스 프록시 (HTTPS)
```nginx
server {
    listen 443 ssl;
    server_name mcp.company.local;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### PM2로 서버 관리
```bash
# PM2 설치
npm install -g pm2

# 서버 시작
pm2 start src/server.js --name "tts-mcp-server"

# 자동 시작 설정
pm2 startup
pm2 save
```

## 📊 사용량 모니터링

서버 로그에서 사용량을 확인할 수 있습니다:
- TTS 요청 횟수
- 생성된 파일 크기
- 사용자별 요청 (IP 기반)

## 🆘 문제 해결

### 연결 실패
1. 방화벽 설정 확인
2. 서버 상태 확인: `curl http://SERVER_IP:8080/health`
3. 인증 토큰 확인

### TTS 실패
1. OpenAI API 키 확인
2. 네트워크 연결 확인
3. API 사용량 한도 확인

## 📝 라이선스

MIT License 