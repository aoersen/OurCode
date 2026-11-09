# 第三方署名 / Third-party notice

## dsh-purge（提示词预设来源）

- 上游仓库：<https://github.com/YuJunZhiXue/dsh-purge>
- 作者：YuJunZhiXue
- 许可：Apache-2.0（见上游 `LICENSE`、`NOTICE`）
- 使用范围：`dsh-purge.zh.enc.json` 是上游 `lib/default-prompt-inject.zh.md`（v1.1.82）
  逐字文本的 AES-256-GCM 密文；运行时由 `src/services/noLimits/presets/cipher.ts`
  解密还原，再由 `src/services/noLimits/policy.ts` 的 `stripChatTemplateMarkers()`
  去掉聊天模板标记（`<|im_start|>` / `<|im_end|>`）。解密后的正文与上游逐字一致，
  本项目不改写内容。
- 为什么加密：避免提示词正文被 git / GitHub code search 直接检索到；明文只在应用
  加载预设时存在于内存。加密不改变署名与许可义务。
- 上游要求：二次开发必须署名来源仓库。本项目在设置面板「无限制模式」分区、
  `docs/no-limits.md` 与本文件中均标注了来源与许可，保留本文件即可满足署名要求。

上游只对 DSH 宿主做破甲；本项目是把同一套能力（提示词覆盖 / 免审批 / 危险命令豁免）
接进 OurCode-ide 自己的 agent 运行时，不修改任何宿主文件。
