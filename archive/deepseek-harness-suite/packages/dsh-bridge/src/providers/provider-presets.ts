export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  supportedModels: string[];
  contextLimit: number;
  description: string;
  envKeyName: string;
}

export const KNOWN_PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek Official API',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-reasoner',
    supportedModels: ['deepseek-reasoner', 'deepseek-chat'],
    contextLimit: 128000,
    description: '官方直连，原生支持 DeepSeek-R1 推理思维链与 V3 极速推理',
    envKeyName: 'DEEPSEEK_API_KEY',
  },
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-R1',
    supportedModels: ['deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3'],
    contextLimit: 128000,
    description: '国内高并发高速推理节点，与 OpenAI 格式 100% 兼容',
    envKeyName: 'SILICONFLOW_API_KEY',
  },
  volcengine: {
    id: 'volcengine',
    name: 'Volcengine Ark (火山引擎)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'ep-deepseek-r1',
    supportedModels: ['ep-deepseek-r1', 'ep-deepseek-v3'],
    contextLimit: 128000,
    description: '火山方舟大模型服务，企业级 SLA 保障与端点接入',
    envKeyName: 'ARK_API_KEY',
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local Private Node)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'deepseek-r1:14b',
    supportedModels: ['deepseek-r1:1.5b', 'deepseek-r1:7b', 'deepseek-r1:14b', 'deepseek-r1:32b', 'deepseek-r1:70b'],
    contextLimit: 32768,
    description: '本地离线私有化运行，零数据外流，无 API Key 依赖',
    envKeyName: 'OLLAMA_API_KEY',
  },
  vllm: {
    id: 'vllm',
    name: 'vLLM Self-Hosted Cluster',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'deepseek-ai/DeepSeek-R1',
    supportedModels: ['deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-V3'],
    contextLimit: 65536,
    description: '自建私有 GPU 高性能集群推理服务',
    envKeyName: 'VLLM_API_KEY',
  },
};

/**
 * Provider Preset Manager & Router
 * 
 * Manages provider profiles inspired by the deepseek-harness-handbook provider chapter.
 */
export class DshProviderManager {
  public static getPreset(id: string): ProviderPreset | undefined {
    return KNOWN_PROVIDER_PRESETS[id.toLowerCase()];
  }

  public static listPresets(): ProviderPreset[] {
    return Object.values(KNOWN_PROVIDER_PRESETS);
  }

  public static formatPresetsList(activeProviderId = 'deepseek'): string {
    let text = `🌐 DeepSeek Harness Supported Model Providers:\n\n`;
    for (const p of this.listPresets()) {
      const isCurrent = p.id.toLowerCase() === activeProviderId.toLowerCase();
      const badge = isCurrent ? '👉 [ACTIVE]' : '  ';
      text += `${badge} [${p.id}] ${p.name}\n`;
      text += `     Endpoint: ${p.baseUrl}\n`;
      text += `     Default Model: ${p.defaultModel} (Context: ${(p.contextLimit / 1024).toFixed(0)}k)\n`;
      text += `     Env Key: ${p.envKeyName}\n`;
      text += `     Note: ${p.description}\n\n`;
    }
    text += `To switch provider in session, use: /provider switch <id> [model]`;
    return text.trim();
  }
}
