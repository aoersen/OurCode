# 提示词预设的加密存储

本目录的提示词正文**不以明文入库**。仓库里只有：

| 文件 | 说明 |
| --- | --- |
| `dsh-purge.zh.enc.json` | 上游 dsh-purge 中文预设的 AES-256-GCM 密文 |
| `keyijiang.zh.enc.json` | 本项目内置「可以酱」人格的 AES-256-GCM 密文 |
| `cipher.meta.json` | 算法版本、KDF 材料与 AAD（运行时解密用） |
| `cipher.ts` | 运行时解密（WebCrypto，模块加载时执行一次） |
| `index.ts` | 预设元数据 + 解密后的正文 |
| `NOTICE.md` | 第三方署名（dsh-purge，Apache-2.0） |

明文只在两种时刻出现：应用加载 `index.ts` 时解密到内存；维护者本地执行
`npm run presets:decode` 时写到被 `.gitignore` 排除的 `*.zh.md`。

## 维护流程

```bash
# 1. 解出明文到本目录（*.zh.md，已被 gitignore）
npm run presets:decode

# 2. 编辑 src/services/noLimits/presets/keyijiang.zh.md（或 dsh-purge.zh.md）

# 3. 重新加密（会覆盖 *.enc.json，并在成功后删除本地明文）
npm run presets:encode

# 4. 校验：无明文残留 + 两个密文都能解密 + NOTICE 仍在
npm run presets:check
```

`npm run build` 会先跑 `presets:check`；单测里也有同样的守卫，明文文件或损坏的
密文会直接让 CI 失败。

## 注意

- **这不是强保密**。`cipher.meta.json` 随仓库一起分发，能运行本应用的人最终都能
  还原正文；它的目标是让提示词正文不出现在 git 历史 / code search / diff 里，而不是
  抵抗有备而来的逆向。
- 不要单独修改 `cipher.meta.json` 的 `keyMaterial` / `aad` / `v`：改了必须重新
  `presets:encode` 全部预设，否则运行时解密失败（`presets:check` 会拦住）。
- 如果明文曾经被提交过，仅仅删除文件不够——它还留在 git 历史里，需要改写历史后
  强制推送（确认没有其他协作者后再做）：

  ```bash
  # filter-repo 会重写本地所有 ref；完成后把所有受影响分支强推到每个远端
  git filter-repo --path src/services/noLimits/presets/dsh-purge.zh.md \
                  --path src/services/noLimits/presets/keyijiang.zh.md --invert-paths
  git remote add origin <url>   # filter-repo 会移除 origin，按需重新添加
  git push --force-with-lease --all origin
  ```

  只要某个分支（如旧的 `no-limits` / `new-ui`）还指向旧提交，明文就仍然可检索；
  要么一并重写强推，要么删除这些分支。Gitee 等其他远端同理。GitHub 的代码搜索
  索引可能滞后，必要时联系支持清理缓存。
