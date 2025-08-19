#!/usr/bin/env node

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import express from "express";
import cors from "cors";
import axios from "axios";
import https from "https";
import fs from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

const app = express();
const PORT = process.env.PORT || 8080;
// 퍼블릭 경로 프리픽스(예: Nginx로 /tts 하위에 노출 시 '/tts', Cloud Run은 기본 '')
const PUBLIC_BASE_PATH_RAW = (process.env.PUBLIC_BASE_PATH || '').trim();
const PUBLIC_BASE_PATH = (!PUBLIC_BASE_PATH_RAW || PUBLIC_BASE_PATH_RAW === '/')
  ? ''
  : (PUBLIC_BASE_PATH_RAW.startsWith('/') ? PUBLIC_BASE_PATH_RAW : `/${PUBLIC_BASE_PATH_RAW}`);
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'your-secret-token'; // (미사용) OAuth 미지원 환경 대응으로 인증 비활성화
// Nginx 프록시 하에서 req.protocol, req.ip 등을 신뢰
app.set('trust proxy', true);

// CORS 설정 (Claude Desktop 호환: credentials=false, 헤더 와일드카드)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*'],
  credentials: false
}));

// /messages는 raw-body를 사용하므로 express.json()이 바디를 선점하지 않도록 우회
app.use((req, res, next) => {
  if (req.path === '/messages') {
    return next();
  }
  return express.json()(req, res, next);
});

// CORS 사전요청(Preflight) 빠른 응답
app.options('/sse', (req, res) => res.sendStatus(204));
app.options('/messages', (req, res) => res.sendStatus(204));

// 오디오 파일 저장 디렉토리
const audioDir = path.join(projectRoot, 'generated_audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// 정적 파일 제공
app.use('/audio', express.static(audioDir));

// 인증 비활성화 (Claude 커넥터 OAuth 전용 제약 대응)

// MCP 서버 생성
const server = new Server(
  {
    name: "openai-tts-remote-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// SSE 트랜스포트 (단일 세션 관리)
let sseTransport = null;

// SSE 스트림 연결 (GET)
app.get('/sse', async (req, res) => {
  try {
    console.log('[SSE] incoming GET /sse');
    console.log('      ip=', req.ip, ' ua=', req.get('user-agent'));
    console.log('      headers=', JSON.stringify(req.headers));
    // 프록시 유무에 따라 절대 URL 엔드포인트 생성
    const forwardedProto = req.get('x-forwarded-proto');
    const forwardedHost = req.get('x-forwarded-host');
    const scheme = forwardedProto || req.protocol || 'http';
    const host = forwardedHost || req.get('host');
    // 공개 경로: Cloud Run("") 또는 Nginx("/tts") 등 환경에 맞춰 조정
    const publicEndpointPath = `${PUBLIC_BASE_PATH}/messages`;
    const absoluteEndpoint = `${scheme}://${host}${publicEndpointPath}`;

    sseTransport = new SSEServerTransport(absoluteEndpoint, res);
    await server.connect(sseTransport); // connect()가 start()를 자동 호출
    console.log('✅ MCP 서버가 SSE 전송으로 연결되었습니다.');
  } catch (error) {
    console.error('❌ SSE 연결 중 오류:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: String(error) });
    }
  }
});

// MCP 메시지 수신 (POST)
app.post('/messages', async (req, res) => {
  try {
    console.log('[MCP] incoming POST /messages');
    console.log('      ip=', req.ip, ' ua=', req.get('user-agent'));
    console.log('      headers=', JSON.stringify(req.headers));
    if (!sseTransport) {
      res.status(500).send('SSE connection not established');
      return;
    }
    await sseTransport.handlePostMessage(req, res);
  } catch (error) {
    console.error('❌ POST 메시지 처리 중 오류:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: String(error) });
    }
  }
});

// 도구 목록 정의
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "text_to_speech",
        description: "텍스트를 음성으로 변환합니다. OpenAI의 TTS API를 사용합니다.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "음성으로 변환할 텍스트",
            },
            voice: {
              type: "string",
              enum: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
              default: "alloy",
              description: "사용할 음성 종류",
            },
            model: {
              type: "string",
              enum: ["tts-1", "tts-1-hd"],
              default: "tts-1",
              description: "사용할 TTS 모델 (tts-1: 빠름, tts-1-hd: 고품질)",
            },
            speed: {
              type: "number",
              minimum: 0.25,
              maximum: 4.0,
              default: 1.0,
              description: "음성 속도 (0.25 ~ 4.0)",
            },
            format: {
              type: "string",
              enum: ["mp3", "opus", "aac", "flac"],
              default: "mp3",
              description: "오디오 파일 형식",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "list_audio_files",
        description: "생성된 오디오 파일 목록을 조회합니다.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "delete_audio_file",
        description: "지정된 오디오 파일을 삭제합니다.",
        inputSchema: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "삭제할 오디오 파일명",
            },
          },
          required: ["filename"],
        },
      },
    ],
  };
});

// 도구 실행 핸들러
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "text_to_speech": {
        const {
          text,
          voice = "alloy",
          model = "tts-1",
          speed = 1.0,
          format = "mp3",
        } = args;

        if (!text || text.trim() === "") {
          throw new Error("텍스트가 제공되지 않았습니다.");
        }

        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY 환경변수가 설정되지 않았습니다.");
        }

        // 파일명 생성
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const textPreview = text.substring(0, 30).replace(/[^a-zA-Z0-9가-힣]/g, "_");
        const filename = `tts_${timestamp}_${textPreview}.${format}`;
        const filepath = path.join(audioDir, filename);

        // SSL 검증 비활성화된 HTTPS 에이전트
        const httpsAgent = new https.Agent({
          rejectUnauthorized: false
        });

        // OpenAI TTS API 호출
        const response = await axios({
          method: 'POST',
          url: 'https://api.openai.com/v1/audio/speech',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          data: {
            model: model,
            voice: voice,
            input: text,
            speed: speed,
            response_format: format,
          },
          responseType: 'arraybuffer',
          httpsAgent: httpsAgent,
          timeout: 30000,
        });

        // 오디오 데이터를 파일로 저장
        const buffer = Buffer.from(response.data);
        fs.writeFileSync(filepath, buffer);

        return {
          content: [
            {
              type: "text",
              text: `✅ 텍스트가 성공적으로 음성으로 변환되었습니다!

📝 **입력 텍스트**: ${text}
🎵 **음성**: ${voice}
🤖 **모델**: ${model}
⚡ **속도**: ${speed}x
📁 **형식**: ${format}
💾 **파일명**: ${filename}
📊 **크기**: ${(buffer.length / 1024).toFixed(2)} KB
파일이 서버에 저장되었습니다.`,
            },
          ],
        };
      }

      case "list_audio_files": {
        if (!fs.existsSync(audioDir)) {
          return {
            content: [
              {
                type: "text",
                text: "생성된 오디오 파일이 없습니다.",
              },
            ],
          };
        }

        const files = fs.readdirSync(audioDir);
        const audioFiles = files.filter(file => 
          file.endsWith('.mp3') || 
          file.endsWith('.opus') || 
          file.endsWith('.aac') || 
          file.endsWith('.flac')
        );

        if (audioFiles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "생성된 오디오 파일이 없습니다.",
              },
            ],
          };
        }

        const fileList = audioFiles.map((file, index) => {
          const filepath = path.join(audioDir, file);
          const stats = fs.statSync(filepath);
          const size = (stats.size / 1024).toFixed(2);
          const created = stats.birthtime.toLocaleString('ko-KR');
          
          return `${index + 1}. **${file}**\n   📁 크기: ${size} KB\n   📅 생성일: ${created}`;
        }).join('\n\n');

        return {
          content: [
            {
              type: "text",
              text: `🎵 **생성된 오디오 파일 목록** (총 ${audioFiles.length}개)\n\n${fileList}`,
            },
          ],
        };
      }

      case "delete_audio_file": {
        const { filename } = args;
        
        if (!filename) {
          throw new Error("삭제할 파일명이 제공되지 않았습니다.");
        }

        const filepath = path.join(audioDir, filename);
        
        if (!fs.existsSync(filepath)) {
          throw new Error(`파일을 찾을 수 없습니다: ${filename}`);
        }

        fs.unlinkSync(filepath);

        return {
          content: [
            {
              type: "text",
              text: `✅ 파일이 성공적으로 삭제되었습니다: ${filename}`,
            },
          ],
        };
      }

      default:
        throw new Error(`알 수 없는 도구: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `❌ 오류가 발생했습니다: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    server: 'OpenAI TTS Remote MCP Server',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 서버 정보
app.get('/', (req, res) => {
  res.json({
    name: 'OpenAI TTS Remote MCP Server',
    version: '1.0.0',
    description: 'Remote MCP server for OpenAI Text-to-Speech API',
    endpoints: {
      health: '/health',
      sse: '/sse',
      audio: '/audio'
    },
    authentication: 'none',
    usage: 'Add this server to Claude Desktop via Settings → Connectors'
  });
});

// 서버 시작
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 OpenAI TTS Remote MCP 서버가 시작되었습니다.`);
  console.log(`📍 주소: http://0.0.0.0:${PORT}`);
  console.log(`💚 헬스 체크: http://0.0.0.0:${PORT}/health`);
  console.log(`🔌 MCP 엔드포인트: http://0.0.0.0:${PORT}/sse`);
  console.log(`🎧 오디오 파일: http://0.0.0.0:${PORT}/audio/`);
  console.log('');
  console.log('📋 Claude Desktop 연결 방법:');
  console.log('1. Claude Desktop → Settings → Connectors → Add Custom Connector');
  console.log(`2. URL: http://YOUR_SERVER_IP:${PORT}/sse`);
  console.log('3. Headers: (none)');
});
