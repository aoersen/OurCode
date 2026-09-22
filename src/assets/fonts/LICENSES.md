# Bundled fonts

随产物分发的字体(不再向 Google Fonts 取),便于局域网/离线部署。

| 文件 | 字体 | 授权 | 来源 |
| --- | --- | --- | --- |
| `plus-jakarta-sans-*.woff2` | Plus Jakarta Sans (variable, latin / latin-ext 子集) | SIL Open Font License 1.1 | https://fonts.google.com/specimen/Plus+Jakarta+Sans |
| `jetbrains-mono-*.woff2` | JetBrains Mono (variable, latin / latin-ext 子集) | SIL Open Font License 1.1 | https://fonts.google.com/specimen/JetBrains+Mono |

OFL 1.1 全文:https://openfontlicense.org

图标不再使用 Material Symbols 连字字体(整包 3.9MB,且离线会退化成字面文本)。
`src/components/Common/icons/materialPaths.ts` 里的 27 个 path 数据由 Material Symbols
Outlined 字形轮廓导出,该字体族为 Apache License 2.0:
https://fonts.google.com/icons · https://www.apache.org/licenses/LICENSE-2.0
