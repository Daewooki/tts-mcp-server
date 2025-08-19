#!/usr/bin/env node

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import fs from "fs";
import axios from "axios";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

const app = express();
const PORT = process.env.PORT || 8080;

// CORS 설정
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*'],
  credentials: false
}));

app.use(express.json());

// 요청 로깅 미들웨어
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n🔍 [${timestamp}] ${req.method} ${req.url}`);
  console.log(`   📡 IP: ${req.ip}`);
  console.log(`   📋 Headers:`, JSON.stringify(req.headers, null, 2));
  
  if (req.method === 'POST' && req.body) {
    console.log(`   📦 Body:`, JSON.stringify(req.body, null, 2));
  }
  
  // 응답 로깅
  const originalSend = res.send;
  res.send = function(data) {
    console.log(`   ✅ Response: ${res.statusCode}`);
    if (data) {
      console.log(`   📤 Response Data:`, typeof data === 'string' ? data.substring(0, 200) : data);
    }
    console.log(`   ⏱️  Duration: ${Date.now() - new Date(timestamp).getTime()}ms\n`);
    return originalSend.call(this, data);
  };
  
  next();
});

// 오디오 파일 저장 디렉토리
const audioDir = path.join(projectRoot, 'generated_audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

// 정적 파일 제공
app.use('/audio', express.static(audioDir));

// MCP 서버 정보
const SERVER_INFO = {
  name: "openai-tts-server",
  version: "1.0.0",
  protocolVersion: "2024-11-05",  // Claude가 지원하는 프로토콜 버전
  capabilities: {
    tools: {}
  },
  // 인증 없는 서버임을 명시
  auth: {
    type: "none"
  }
};

// 도구 정의
const TOOLS = [
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
          description: "사용할 TTS 모델",
        },
        speed: {
          type: "number",
          minimum: 0.25,
          maximum: 4.0,
          default: 1.0,
          description: "음성 속도",
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
];

// MCP 엔드포인트 GET 요청 (서버 발견용)
app.get('/mcp/v1/messages', (req, res) => {
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocolVersion: SERVER_INFO.protocolVersion,
    capabilities: SERVER_INFO.capabilities,
    transport: {
      type: "http",
      endpoint: "/mcp/v1/messages"
    },
    auth: SERVER_INFO.auth,
    description: "OpenAI TTS Remote MCP Server - Use POST for actual MCP messages"
  });
});

// Streamable HTTP 엔드포인트 - MCP 메시지 처리
app.post('/mcp/v1/messages', async (req, res) => {
  const message = req.body;
  
  try {
    let response;

    switch (message.method) {
      case 'initialize':
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: SERVER_INFO.protocolVersion,
            capabilities: SERVER_INFO.capabilities,
            serverInfo: {
              name: SERVER_INFO.name,
              version: SERVER_INFO.version
            }
          }
        };
        break;

      case 'tools/list':
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: TOOLS
          }
        };
        break;

      case 'tools/call':
        const { name, arguments: args } = message.params;
        let toolResult;

        if (name === 'text_to_speech') {
          toolResult = await handleTextToSpeech(args);
        } else if (name === 'list_audio_files') {
          toolResult = await handleListAudioFiles();
        } else {
          throw new Error(`Unknown tool: ${name}`);
        }

        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: toolResult
        };
        break;

      default:
        response = {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `Unknown method: ${message.method}`
          }
        };
    }

    res.json(response);
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32603,
        message: error.message
      }
    });
  }
});

// TTS 처리 함수
async function handleTextToSpeech(args) {
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

// 파일 목록 처리 함수
async function handleListAudioFiles() {
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

// MCP 서버 발견 엔드포인트 (.well-known)
app.get('/.well-known/mcp', (req, res) => {
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocolVersion: SERVER_INFO.protocolVersion,
    capabilities: SERVER_INFO.capabilities,
    transport: {
      type: "http",
      endpoint: "/mcp/v1/messages"
    },
    auth: SERVER_INFO.auth,
    description: "OpenAI TTS Remote MCP Server"
  });
});

// MCP 서버 정보 엔드포인트 (Claude Desktop 검증용)
app.get('/mcp/v1/server-info', (req, res) => {
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    protocolVersion: SERVER_INFO.protocolVersion,
    capabilities: SERVER_INFO.capabilities,
    auth: SERVER_INFO.auth,
    description: "OpenAI TTS Remote MCP Server"
  });
});

// 서버 정보 엔드포인트 (Claude Desktop 자동 발견용)
app.get('/', (req, res) => {
  res.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description: "OpenAI TTS Remote MCP Server",
    protocolVersion: SERVER_INFO.protocolVersion,
    capabilities: SERVER_INFO.capabilities,
    transport: {
      type: "http",
      endpoint: "/mcp/v1/messages"
    },
    endpoints: {
      messages: "/mcp/v1/messages",
      serverInfo: "/mcp/v1/server-info",
      health: "/health"
    }
  });
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    server: SERVER_INFO.name,
    version: SERVER_INFO.version,
    timestamp: new Date().toISOString()
  });
});

// 서버 시작
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Remote MCP TTS 서버가 포트 ${PORT}에서 시작되었습니다.`);
  console.log(`💚 헬스 체크: http://0.0.0.0:${PORT}/health`);
  console.log(`🔌 MCP 엔드포인트: http://0.0.0.0:${PORT}/mcp/v1/messages`);
  console.log(`🌐 서버 정보: http://0.0.0.0:${PORT}/`);
}); 