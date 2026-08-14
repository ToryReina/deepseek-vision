# deepseek-vision

让不具备原生视觉能力的 DeepSeek 模型获得识图能力 —— 通过 **DSH tool 插件** 把图片识别为文字描述。

> 基于 [`create-dsh-plugin`](https://www.npmjs.com/package/create-dsh-plugin) 生成的 tool 插件模板。

## 它解决什么

DSH 的 `read_image` 工具要求模型声明 `image` 输入能力（`inputModalities` 含 `image`），
文本模型（如 DeepSeek 系列）被门禁挡住。本插件解决**两个问题**：

1. **发图被拒**：插件给已注册的 DeepSeek adapter 打运行时补丁，声明支持图片输入，
   默认模型（无需切换）即可上传图片。
2. **模型无视觉**：模型把图片路径传给 `deepseek_vision` 工具 → 插件读文件 →
   调阿里云百炼（OpenAI 兼容 vision API）→ 返回中文描述。任何文本模型都能"看图"。

额外能力：**识图成功后自动删除 DSH 附件目录下的临时图片副本**（描述已进入上下文，
附件无保留价值；用户自己指定的其他本地文件不误删）。

## 安装

**前置条件**：已安装 DeepSeek Harness（DSH）并运行 web profile（`npx @deepseek-ai/dsh web`）。

```bash
# 1. 克隆/下载本插件源码后，进入插件目录
cd DeepSeek-vision

# 2. 构建
pnpm install && pnpm run build

# 3. 安装到 DSH 的 web profile（从插件**父目录**执行）
cd ..
dsh plugin --profile web add ./DeepSeek-vision

# 4. 重启 DSH（重要）
npx @deepseek-ai/dsh web
```

**验证安装成功**：重启后终端应看到这两行日志：

```
[deepseek-vision] patched "deepseek-official" adapter to accept image input (no model switch needed)
[deepseek-vision] registered "deepseek_vision" — listed=true
```

> 看到 `registered ... listed=true` 即安装成功；只看到 patch 行说明工具注册有问题，检查 `dsh plugin` 安装是否正确。

## 配置

插件注册 `deepseek-vision` 设置命名空间（写入 `~/.dsh/settings.yaml`），
也可用环境变量兜底。**二选一配置 API Key 即可**。

### 先获取阿里云百炼 API Key

1. 打开 [阿里云百炼控制台](https://bailian.console.aliyun.com/)（需注册/登录阿里云账号）
2. 进入 **API-KEY 管理** 页面
3. 点击 **创建我的 API-KEY**，复制生成的 Key（形如 `sk-...`）
4. 新用户通常有免费额度，可先试用再决定是否付费

### 方式一：环境变量（推荐，最简单）

启动 dsh 前导出：

```bash
export DASHSCOPE_API_KEY="你的百炼Key"
export VISION_MODEL="qwen3.7-flash-2026-07-15"   # 可选，默认值即可
npx @deepseek-ai/dsh web
```

### 方式二：settings.yaml 配置

在 `~/.dsh/settings.yaml` 添加（或修改）：

```yaml
deepseek-vision:
  apiKey: "你的百炼Key"
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  model: "qwen3.7-flash-2026-07-15"
  maxBytes: 10485760
  deleteAfter: true
```

### 配置项说明

| 设置项 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | `DASHSCOPE_API_KEY` / `IMA_VISION_API_KEY` | `DASHSCOPE_API_KEY` | 阿里云百炼 API Key（[获取](https://bailian.console.aliyun.com/)） |
| `baseUrl` | `VISION_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容地址 |
| `model` | `VISION_MODEL` | `qwen3.7-flash-2026-07-15` | 视觉模型名（如 `qwen-vl-max`、`qwen3.5-omni-plus`） |
| `maxBytes` | — | 10485760 (10MB) | 单张图片大小上限 |
| `deleteAfter` | — | `true` | 识图后是否删除 DSH 附件目录下的图片副本 |

> **推荐视觉模型**：默认 `qwen3.7-flash-2026-07-15` 性价比高；需要更强识别
> （复杂表格、手写、小字）时换 `qwen-vl-max`。

## 工具

### `deepseek_vision`

**参数**
- `image_path`（必填）：图片文件绝对路径（PNG/JPEG/WebP/GIF/BMP）
- `prompt`（可选）：对图片的具体问题，默认要求详细中文描述

**返回**
- `description`：图片内容的文字描述
- `image_path`：被读取的图片路径

**说明**：附件文件无扩展名也能识别（按文件头魔数检测真实格式，扩展名仅兜底）。

## 使用

安装并配置完成后，**无需任何额外操作**，像平时一样发图即可：

1. **打开 DSH Web 界面**（`http://127.0.0.1:3080`）
2. **新建会话**（建议；旧会话也能识别，但新会话体验最佳）
3. **直接上传/粘贴图片**——**不需要切换模型**，用默认的 `DeepSeek-V4-Flash` 即可
4. 发送后，模型会自动调用 `deepseek_vision` 工具识别图片，并基于返回的文字描述回复你

**具体表现**：
- 图片成功上传（插件已给 DeepSeek adapter 打补丁，准入放行）
- 模型回复中会说明「我调用了 deepseek_vision 工具」或直接给出图片描述
- 识别完成后，上传的图片临时副本**自动删除**（可在设置中关闭 `deleteAfter`）

**常见问题**：
- **发图被拒「当前模型不支持图片」** → 插件 patch 未生效，检查安装日志的 `patched` 行
- **识别报「未配置 API Key」** → 检查 `DASHSCOPE_API_KEY` 环境变量或 settings.yaml 配置
- **模型没有自动调用工具** → 确认是新会话，且日志有 `registered ... listed=true`

## 开发

```bash
pnpm run build        # tsc 构建到 dist/
pnpm run typecheck    # 仅类型检查
```

## 原理

```
用户上传图片 → 插件 patch adapter（准入放行）
   → 图片转文本路径提示（renderImageBlocks）
   → 模型调用 deepseek_vision(image_path)
   → 插件 readFile 读图片 + 魔数检测 MIME
   → POST /chat/completions（base64 图片 + prompt）→ 百炼 vision 模型
   → 返回文字描述 → 模型据此回答用户
   → 附件副本自动删除
```

凭证只发送到配置的 `baseUrl`（默认阿里云百炼），不经过其他服务。
