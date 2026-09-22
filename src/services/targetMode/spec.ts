/**
 * Target-mode spec document (`.ourcode/targemode/SPEC.md`).
 *
 * This is the single authoritative copy of the target-mode operating spec:
 * it is written into the project at initialization (see targetModeService),
 * and the system prompt embeds it so the agent still has it even if the
 * on-disk copy is missing.
 */

export const TARGET_MODE_SPEC_MD = `# 目标模式运行规范

## 一、初始化
进入目标模式后，立即执行以下初始化动作：

1. 若 .ourcode/targemode/index.md 不存在，则创建空文件（稍后写入索引）。
2. 若 .ourcode/targemode/implementationStatus.md 不存在，则创建并写入初始状态：
   - 当前轮次：0（表示尚未开始第一轮）
   - 实施进度：未开始
   - 历史记录：（空）
3. 自动检查项目根目录的 .gitignore 文件，确保其中包含一行：
   \`\`\`
   .ourcode/targemode/
   \`\`\`
   若缺失则自动追加；若用户已明确将 .ourcode/targemode/ 加入版本控制，则尊重用户选择（但默认不提交）。
4. 后续在 .ourcode/targemode/ 下任何新增、删除或重命名文件/目录时，都必须同步更新 index.md 的索引条目，记录每个文档/目录的用途与最后修改时间。

## 二、最终目标文档（finalGoal.md）
用户输入需求后，首先与用户充分交互，澄清所有不确定点，生成 .ourcode/targemode/finalGoal.md。

finalGoal.md 必须包含：
- 总体目标描述
- 可验证的检查清单（功能点、性能指标、约束条件等），用于后续比对
- 目标的优先级（如有）

确认完毕后，原则上不再主动询问用户问题，除非遇到仅靠当前信息无法决策的阻塞性问题（如技术不可行、目标间冲突、缺少必要外部资源/权限等）。

## 三、规划阶段
根据 finalGoal.md 制定本轮实施规划，规划必须分阶段，每个阶段明确：
- 做什么（具体任务）
- 怎么做（方法、涉及文件/模块）
- 阶段完成标准（可验证的输出物）

第一轮规划存放在 .ourcode/targemode/loop1/sp/ 目录，第二轮存 loop2/sp/，以此类推。每个阶段分配唯一标识（如 phase-1, phase-2），以便进度跟踪。

在最终目标确定和首次规划时，若存在任何不确定点，必须全部向用户确认。一旦规划确认，在无用户干预的情况下，仅可因申请权限等必要操作主动询问，其他情况一律自主决策推进。

## 四、实施阶段
按规划顺序执行各阶段，每完成一个阶段，立刻更新：
- .ourcode/targemode/loopN/progress.md（或 progress.json），记录当前阶段ID、状态（未开始/进行中/已完成）、完成时间、备注
- .ourcode/targemode/implementationStatus.md 的当前进度摘要（轮次、已完成阶段数、总体百分比），并将本次更新追加到历史记录（可压缩记录）

实施过程中产生的所有行动、修改的文件列表、遇到的问题（无论是否解决）均记录到 .ourcode/targemode/loopN/implementation_log.md，做到全程可追溯。

若实施中遇到阻塞且符合主动询问例外条件，必须清晰记录问题细节和询问点，待用户回复后继续。

## 五、比对阶段
一轮所有阶段实施完成后，立即进入比对：
1. 读取 finalGoal.md 中的检查清单，逐项检查项目现状（代码、测试、配置等）。
2. 生成 .ourcode/targemode/loopN/comparison.md，内容包括：
   - 每项目标的状态（已实现 / 部分实现 / 未实现）
   - 具体差距描述
   - 整体覆盖率或达成度摘要
3. 将比对摘要及结论写入 implementationStatus.md 的当前轮次信息中。

## 六、迭代与循环控制
- 若比对发现仍有未实现或部分实现的目标项，则自动进入下一轮（轮次+1），从规划阶段开始新循环（基于剩余差距制定新规划）。
- 若所有目标项均达成，则标记项目完成，写入 implementationStatus.md 最终状态，并停止循环。
- 最多迭代次数可在首次规划时与用户约定（无约定则不限，但AI应在连续两轮无明显进展时主动提示用户）。

## 七、用户主动干预处理
用户任何非阻塞回复或新指令均视为主动干预。AI 需自行判断：
- 干预是否导致最终目标需要根本性变更 → 若是，则将当前所有 loopN 目录移动至 .ourcode/targemode/_archive/（按时间戳命名），重置轮次计数，重新生成/修订 finalGoal.md，然后从第一轮重新开始规划。
- 干预仅属于微调或局部补充 → 修订 finalGoal.md（保留修改记录），评估当前循环内的已完成实施与新目标的差距，在现有 loop 目录下生成 delta_plan.md，并继续当前轮次或追加新阶段。

所有目标变更历史均备份：原 finalGoal.md 复制为 finalGoal_v{N}.md 并更新索引。

## 八、文件结构与索引说明（示例）
\`\`\`
.ourcode/targemode/
  index.md                      # 所有文档/目录的索引清单
  implementationStatus.md       # 总状态：轮次、进度摘要、历史
  finalGoal.md                  # 当前最终目标（含检查清单）
  finalGoal_v1.md ...           # 历史目标快照（按需生成）
  agents/                       # 子 Agent 产物（需求/规格/方案/测试报告）
  inbox/                        # 任务信封队列（监管生成）
  budget.md                     # 全局 token 预算（触顶停止自主续跑）
  loop1/
    sp/                         # 本轮规划（多个阶段文档）
    implementation_log.md       # 实施详细日志
    progress.md                 # 阶段进度跟踪
    comparison.md               # 本轮比对报告
  loop2/
    ...
  _archive/                     # 目标变更时旧轮次归档
\`\`\`
index.md 在每次文件生成时由 AI 自动维护，确保每项均可快速定位。

## 九、多 Agent 协作（v2）
监管 Agent（主循环）通过 \`run_subagent\` 派发子任务；角色定义见工作区 \`.ourcode/agents/tm-*.md\`（frontmatter 声明工具白名单、读写路径、预算，可直接修改，改后生效）。

1. **角色清单**：
   - \`tm-requirement-analyst\`：需求澄清，产出可验证检查清单（只写 \`.ourcode/targemode\`）；
   - \`tm-developer\`：业务实现（数据模型/API/业务逻辑，全量权限）；
   - \`tm-ui-developer\`：UI 实现（界面/交互/样式）；
   - \`tm-tester\`：独立验证（只写测试文件与测试报告，可读全仓，**不修改业务代码**）。
2. **派发规则**：
   - 需求澄清 → \`tm-requirement-analyst\`；
   - phase 为功能实现 → \`tm-developer\` / \`tm-ui-developer\`（按 phase 类型）；
   - 阶段完成或修复后 → \`tm-tester\` 独立验证；
   - 子任务可并行时 → 同一批多个 \`run_subagent\`，但 \`files_to_modify\` 必须互不重叠。
3. **任务信封**：\`run_subagent\` 的 prompt 按信封模板构造（frontmatter：from/to/type/phase/status/files_to_modify/files_to_read/acceptance/fix_attempts/model/report_path）。子 Agent 完成后报告首行为 \`状态: 完成 | 部分完成 | 阻塞 | 失败\`（系统生成），监管以此决策，全文见 \`agents/*.md\` 或信封 report_path。
4. **验收门**：每个 phase 完成 → 派 \`tm-tester\` → 读 \`agents/test_report.md\` → 逐条对照 \`finalGoal.md\` 检查清单（auto 类以工具链输出为准）。任一失败 → 生成 fix 信封派回对应角色，不得带着已知失败进入下一阶段。实现角色完成后必须运行 typecheck + 测试并贴出原始输出。
5. **打回机制**：子 Agent 产出不符合格式 / 偏离任务 → 监管在信封内补充差异描述重新派发，记录到 \`loopN/implementation_log.md\`；同一验收项最多打回 2 次（fix_attempts），之后询问用户。
6. **冲突解决**：并行批次若需改同一文件 → 监管串行化；子 Agent 报告路径越界（被 guard 拦截）→ 监管重新划分边界。
7. **预算与异常**：全局消耗见 \`budget.md\`，触顶停止自主续跑并询问用户；子 Agent 达 token/迭代上限 → 拆分任务或换角色重派；连续两次派发同一任务失败 → 停下询问用户。
`

/** 任务信封 frontmatter 模板（监管构造 run_subagent 的 prompt 时使用）。 */
export const TARGET_MODE_ENVELOPE_TEMPLATE = `---
from: supervisor
to: <角色名>
type: task | fix | review
phase: <阶段ID>
status: pending | done | blocked
files_to_modify: [<允许改的文件，互不重叠>]
files_to_read: [<参考文件>]
acceptance: |
  <验收标准（逐条）>
fix_attempts: <打回次数>
model: <通常省略——省略则自动使用会话模型；确需指定时填写当前配置组支持的模型 id，勿加引号>
report_path: <可选，全文报告写入路径，如 .ourcode/targemode/agents/test_report.md>
---
## 任务描述
## 上下文（相关文件路径/现状）
## 完成后必须报告
`

/** Initial index.md content (placeholder — the agent maintains it afterwards). */
export const TARGET_MODE_INDEX_INIT = `# 目标模式索引

| 路径 | 用途 | 最后修改时间 |
| --- | --- | --- |
| SPEC.md | 目标模式运行规范（权威文档） | - |
| implementationStatus.md | 总状态：轮次、进度摘要、历史 | - |
| agents/ | 子 Agent 产物（需求/规格/方案/测试报告） | - |
| inbox/ | 任务信封队列（监管生成） | - |
| budget.md | 全局 token 预算（触顶停止自主续跑） | - |
`

/** Initial implementationStatus.md content. */
export const TARGET_MODE_STATUS_INIT = `# 目标模式实施状态

- 当前轮次：0
- 实施进度：未开始
- 历史记录：（空）
`
