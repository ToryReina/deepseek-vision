# deepseek-vision

让不具备原生视觉能力的 DeepSeek 模型获得识图能力 —— 通过 **DSH（DeepSeek Harness）tool 插件** 把图片识别为文字描述。

插件源码在 [`DeepSeek-vision/`](./DeepSeek-vision) 目录。

## 它解决什么

1. **发图被拒**：插件给 DeepSeek adapter 打运行时补丁，默认模型（无需切换）即可上传图片。
2. **模型无视觉**：模型调用 `deepseek_vision` 工具 → 插件读图 → 调阿里云百炼 vision API → 返回中文描述。
3. **附件即焚**：识图成功后自动删除 DSH 附件目录下的临时图片副本。

## 快速开始

```bash
# 1. 克隆仓库
git clone git@github.com:ToryReina/deepseek-vision.git
cd deepseek-vision/DeepSeek-vision

# 2. 构建
pnpm install && pnpm run build

# 3. 安装到 DSH web profile（从插件父目录执行）
cd ..
dsh plugin --profile web add ./DeepSeek-vision

# 4. 重启 DSH，看到日志即成功：
#    [deepseek-vision] patched "deepseek-official" adapter to accept image input
#    [deepseek-vision] registered "deepseek_vision" — listed=true
```

## 配置 API Key

二选一：

**环境变量**（推荐）：

```bash
export DASHSCOPE_API_KEY="你的百炼Key"
npx @deepseek-ai/dsh web
```

**settings.yaml**（`~/.dsh/settings.yaml`）：

```yaml
deepseek-vision:
  apiKey: "你的百炼Key"
  model: "qwen3.7-flash-2026-07-15"
```

API Key 获取：https://bailian.console.aliyun.com/（阿里云百炼，新用户有免费额度）

## 使用

新建会话 → 直接上传/粘贴图片 → 模型自动调用 `deepseek_vision` 工具识别并回复。无需切换模型。

## 文档

完整说明（配置项、工具参数、常见问题、原理）见 [`DeepSeek-vision/README.md`](./DeepSeek-vision/README.md)。

## License

MIT
