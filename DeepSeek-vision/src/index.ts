// deepseek-vision — 让不具备原生视觉能力的模型通过调用本工具获得识图能力。
//
// 原理：模型把图片文件路径传给本工具 → 工具读取图片字节 → 调阿里云百炼
// （或其他 OpenAI 兼容的 vision API）→ 返回文字描述。绕过了 DSH 对
// 「模型必须声明 image 输入」的限制，任何文本模型都能"看图"。
//
// 配置（settings namespace `deepseek-vision`，可用环境变量兜底）：
//   apiKey      — 百炼 API Key（默认读 DASHSCOPE_API_KEY 环境变量）
//   baseUrl     — OpenAI 兼容地址（默认 https://dashscope.aliyuncs.com/compatible-mode/v1）
//   model       — 视觉模型名（默认 qwen3.7-flash-2026-07-15）
//   maxBytes    — 单张图片大小上限（默认 10MB）
//
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { readFile, rm } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

export const name = 'deepseek-vision'

export const inject = ['tools', 'llm']

const NS = settingsNamespace('deepseek-vision')

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_MODEL = 'qwen3.7-flash-2026-07-15'

const Config = z.object({
  apiKey: z.string().role('credential-ref').default('DASHSCOPE_API_KEY'),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  maxBytes: z.natural().default(10 * 1024 * 1024),
  deleteAfter: z.boolean().default(true),
})

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/** 按文件头魔数检测 MIME（附件文件无扩展名时必须用这个） */
function detectMime(data: Uint8Array): string | undefined {
  const b = (offset: number) => data[offset]
  if (data.length >= 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png'
  if (data.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg'
  if (data.length >= 12 && b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp'
  if (data.length >= 6 && b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif'
  if (data.length >= 2 && b(0) === 0x42 && b(1) === 0x4d) return 'image/bmp'
  return undefined
}

/** 读配置：settings → 环境变量兜底 */
type ResolvedConfig = ReturnType<typeof Config>
function resolveConfig(config: ResolvedConfig): {
  apiKey: string
  baseUrl: string
  model: string
  maxBytes: number
  deleteAfter: boolean
} {
  const apiKey =
    config.apiKey && config.apiKey !== 'DASHSCOPE_API_KEY'
      ? config.apiKey
      : process.env.DASHSCOPE_API_KEY || process.env.IMA_VISION_API_KEY || ''
  const baseUrl = config.baseUrl || process.env.VISION_BASE_URL || DEFAULT_BASE_URL
  const model = config.model || process.env.VISION_MODEL || DEFAULT_MODEL
  return { apiKey, baseUrl, model, maxBytes: config.maxBytes, deleteAfter: config.deleteAfter }
}

/** 调 OpenAI 兼容的 vision API */
async function callVision(
  apiKey: string,
  baseUrl: string,
  model: string,
  imageData: Uint8Array,
  mime: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = baseUrl.replace(/\/?$/, '/') + 'chat/completions'
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(imageData).toString('base64')}` } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    stream: false,
    max_tokens: 2048,
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`vision API HTTP ${resp.status}: ${text.slice(0, 300)}`)
  }
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('vision API 返回空结果')
  return content
}

export function apply(ctx: Context, config: Record<string, unknown> = {}) {
  const entry = Config(config)
  let current = () => entry
  installSettingsSection(ctx, NS, Config, entry, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })

  // ── 声明 image 能力：给 DeepSeek adapter 打补丁（免切换模型）──
  // 背景：DeepSeek adapter 硬编码 inputModalities:["text"]，host 在 prompt 接口
  //       据此拒绝图片上传（MODEL_DOES_NOT_SUPPORT_IMAGES）。官方插件 API 无法
  //       替换已注册 adapter，因此这里直接给已注册的 adapter 实例打运行时补丁：
  //       在其 resolveModel / listModels 返回时强制声明 image 输入。
  //       这样默认模型（deepseek-official）即支持图片，用户无需切换模型。
  try {
    const baseProvider = 'deepseek-official'
    // 从已注册的 DeepSeek adapter 拿到实例（llm service 内部持有 registration）
    const llmAny = ctx.llm as unknown as {
      adapters?: Map<string, { adapter: unknown }>
    }
    const baseReg = llmAny.adapters?.get(baseProvider)
    if (baseReg?.adapter) {
      const baseAdapter = baseReg.adapter as {
        listModels: (p: string) => Promise<
          { provider: string; id: string; name: string; inputModalities?: string[]; [k: string]: unknown }[]
        >
        resolveModel: (p: string, m: string, s?: AbortSignal) => Promise<{
          provider: string
          id: string
          name: string
          inputModalities?: string[]
          [k: string]: unknown
        }>
      }
      // 保留原始实现引用（插件卸载时无法恢复，但服务重启即恢复，可接受）
      const origResolveModel = baseAdapter.resolveModel.bind(baseAdapter)
      const origListModels = baseAdapter.listModels.bind(baseAdapter)
      const withImage = (mods: string[] | undefined): string[] => {
        const m = Array.isArray(mods) ? [...mods] : []
        if (!m.includes('image')) m.push('image')
        return m
      }
      // 覆盖 resolveModel：返回时补上 image 声明
      baseAdapter.resolveModel = async (p: string, m: string, s?: AbortSignal) => {
        const info = await origResolveModel(p, m, s)
        return { ...info, inputModalities: withImage(info.inputModalities) }
      }
      // 覆盖 listModels：目录里也声明 image（可选，模型选择器展示用）
      baseAdapter.listModels = async (p: string) => {
        const models = await origListModels(p)
        return models.map((mm) => ({ ...mm, inputModalities: withImage(mm.inputModalities) }))
      }
      console.log(`[deepseek-vision] patched "${baseProvider}" adapter to accept image input (no model switch needed)`)
    } else {
      console.log('[deepseek-vision] WARN: DeepSeek adapter not found, image patch NOT applied')
    }
  } catch (e) {
    console.log(`[deepseek-vision] ERROR patching adapter: ${String(e)}`)
  }

  ctx.tools.register(defineTool({
    name: 'deepseek_vision',
    description:
      '读取一张图片并返回其中文文字描述。当用户发送/粘贴图片、提供本地图片路径，' +
      '或要求分析/描述/识别图片内容时，用本工具代替直接看图（当前模型无原生视觉）。' +
      '传入图片文件的绝对路径，返回图片内容的详细中文描述。',

    parameters: {
      image_path: {
        type: 'string',
        required: true,
        description: '图片文件的绝对路径（PNG/JPEG/WebP/GIF/BMP）。',
      },
      prompt: {
        type: 'string',
        description: '可选：对图片的具体问题，如"图片里有什么文字"。默认要求详细中文描述。',
      },
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          description: { type: 'string', required: true, description: '图片内容的文字描述（中文）。' },
          image_path: { type: 'string', required: true, description: '被读取的图片路径。' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `[识图结果 ${value.image_path}]\n${value.description}` },
      ],
    },

    async execute(args, exec) {
      const cfg = resolveConfig(current())
      if (!cfg.apiKey) {
        throw new Error(
          'deepseek-vision 未配置 API Key：请在设置中配置 deepseek-vision.apiKey，或设置环境变量 DASHSCOPE_API_KEY',
        )
      }
      const filePath = args.image_path.trim()
      if (!filePath) throw new Error('image_path 不能为空')
      const resolved = resolve(filePath)
      const data = await readFile(resolved)
      if (data.byteLength > cfg.maxBytes) {
        throw new Error(`图片过大（${data.byteLength} 字节），超过上限 ${cfg.maxBytes}`)
      }
      // MIME 判定：优先魔数检测（附件文件无扩展名），扩展名兜底
      const bytes = new Uint8Array(data)
      let mime = detectMime(bytes)
      if (!mime) {
        const ext = extname(filePath).toLowerCase()
        mime = MIME_BY_EXT[ext]
      }
      if (!mime) {
        throw new Error('deepseek-vision 无法识别该文件为 PNG/JPEG/WebP/GIF/BMP 图片')
      }
      const prompt = args.prompt?.trim() || '请用中文详细描述这张图片的内容，包括所有可见的文字。'
      const description = await callVision(
        cfg.apiKey,
        cfg.baseUrl,
        cfg.model,
        bytes,
        mime,
        prompt,
        exec.signal,
      )
      // 识图成功后清理：仅删除 DSH 附件目录下的临时副本（~/.dsh/attachments/），
      // 用户指定的其他本地文件（如 /tmp/xx.png、桌面图）不误删。
      // 描述已进入上下文，附件副本无保留价值；是否删除可用配置 deleteAfter 控制。
      if (cfg.deleteAfter !== false) {
        try {
          const home = process.env.HOME || process.env.USERPROFILE || ''
          const attachRoot = resolve(home, '.dsh', 'attachments')
          if (resolved.startsWith(attachRoot + '/')) {
            await rm(resolved, { force: true })
          }
        } catch {
          /* 删除失败不影响识别结果 */
        }
      }
      return { description, image_path: filePath }
    },
  }))

  console.log(
    `[deepseek-vision] registered "deepseek_vision" — listed=${ctx.tools.get('deepseek_vision') !== undefined}`,
  )
}
