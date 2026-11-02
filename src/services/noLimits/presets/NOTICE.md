# 第三方署名 / Third-party notice

## dsh-purge（提示词预设来源）

- 上游仓库：<https://github.com/YuJunZhiXue/dsh-purge>
- 作者：YuJunZhiXue
- 许可：Apache-2.0（见上游 `LICENSE`、`NOTICE`）
- 使用范围：`dsh-purge.zh.md` 逐字取自上游 `lib/default-prompt-inject.zh.md`（v1.1.82），
  仅由 `src/services/noLimits/policy.ts` 的 `stripChatTemplateMarkers()` 在运行时去掉
  聊天模板标记（`<|im_start|>` / `<|im_end|>`），文件本身不改写。
- 上游要求：二次开发必须署名来源仓库。本项目在设置面板「无限制模式」分区与
  `docs/no-limits.md` 中均标注了来源与许可，保留本文件即可满足署名要求。

上游只对 DSH 宿主做破甲；本项目是把同一套能力（提示词覆盖 / 免审批 / 危险命令豁免）
接进 OurCode-ide 自己的 agent 运行时，不修改任何宿主文件。
