#!/usr/bin/env node

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import https from "https";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

// 오디오 파일 저장 디렉토리
const audioDir = path.join(projectRoot, 'generated_audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

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
    protocolVersion: "2025-06-18",
    serverInfo: {
      name: "openai-tts-remote-server",
      version: "1.0.0"
    }
  }
);

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
💾 **저장 위치**: ${filepath}

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
          
          return `${index + 1}. **${file}**\n   📁 크기: ${size} KB\n   📅 생성일: ${created}\n   💾 위치: ${filepath}`;
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

// 서버 시작
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("OpenAI TTS MCP 서버가 시작되었습니다.");
}

main().catch((error) => {
  console.error("서버 시작 중 오류 발생:", error);
  process.exit(1);
}); 