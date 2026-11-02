# 内置语音引擎（whisper.cpp）

这个目录是**运行期资源**，不存 git（体积太大），由 `npm run fetch-whisper` 拉取，
`prebuild` 已经挂了 `--if-missing`，正常打包不用手动跑。

```
resources/whisper/
  bin/                     whisper-server.exe + whisper.dll + ggml*.dll + SDL2.dll
  models/ggml-<size>-q8_0.bin
```

## 命令

```bash
npm run fetch-whisper                 # 默认 small（中文明显更好，约 253MB）
npm run fetch-whisper -- --model base # 82MB，够用但错字更多
npm run fetch-whisper -- --model tiny # 43MB，只适合验链路
npm run fetch-whisper -- --force      # 重新下载
npm run fetch-whisper -- --proxy http://127.0.0.1:7897   # 国内网络
```

## 打包后它怎么跑

`electron/services/whisperRuntime.ts` 负责：找空闲端口 → 拉起
`whisper-server.exe`（只监听 `127.0.0.1`）→ 健康检查 → 应用退出时 kill。

- **懒启动**：第一次点麦克风才起进程，空闲客户端不付任何代价。
- **单飞**：连点多次只起一个进程。
- **模型选择**：`userData/whisper/models` 优先于内置目录；同名优先
  `small > base > medium`。想让某个客户用更大的模型，把他的 `ggml-medium-q8_0.bin`
  丢进 `%APPDATA%/OurCode IDE/whisper/models/` 即可，不用重新打包。
- **音频格式**：whisper.cpp 的 `/inference` 只吃 16kHz WAV，所以渲染层用 Web Audio
  把 MediaRecorder 的 webm/opus 解码后重采样成 WAV（`recordingToWavBase64`），
  不依赖 ffmpeg。

## 端点优先级（见 `src/services/speech/stt.ts`）

1. 客户手填的端点（永远最高）
2. **内置引擎**（本目录）
3. 复用客户已配的 LLM key 推导 `/audio/transcriptions`
4. 探测本机已有 whisper 服务（8080/9000/8123/5001）
5. 都没有 → 提示用输入法语音 / `Win+H`

## 想完全不内置

把 `resources/whisper` 整个删掉再打包即可：`whisperStatus()` 会报
`available: false`，端点链自动后退到第 3 步，UI 文案也会跟着变。
