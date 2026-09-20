# dsh-plugin-confirmation-resolution

DSH 待确认事项决策机制 —— `confirmation_resolution`（中文名：**待确认事项决策**）。

一个**宿主平面（host-plane）**的 Cordis 插件，只做两件事：

1. 向全局 `systemPrompt` 注册一个段落 `confirmation:policy`，承载
   `01_DSH_System_Prompt_待确认事项触发规则` 的**运行时规则**：何时汇报待确认事项、
   何时允许调用插件、何时禁止调用、确认项状态管理、混合消息拆分、插件结果如何执行、何时退出流程。
2. 向宿主 `tools` 注册模型工具 `confirmation_resolution`，其决策核心在 `lib/decide.js`，
   实现 `02_Confirmation_Resolution_Plugin_执行规则`。

插件**不修改**页面、代码、文件、设计稿或项目结构：它只判断、决策并返回执行方案，
实际执行由 DSH 完成。它也不发布任何服务，因此不需要 isolate realm。

三份输入文件与产物的分工：

| 输入文件 | 负责 | 落地位置 |
| --- | --- | --- |
| `01_DSH_System_Prompt_待确认事项触发规则` | 触发与执行层 | `lib/rules.js` → 全局 System Prompt 段落 |
| `02_Confirmation_Resolution_Plugin_执行规则` | 插件内部决策层 | `lib/decide.js` + `lib/index.js` 工具定义 |
| `03_DSH_待确认事项决策规范` | 规范、校验与测试层 | `test/`（**不注入** System Prompt，也不进入插件运行时） |

## 目录结构

```
dsh-confirmation-resolution/
├── package.json             # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml         # 宿主行：id confirmation-resolution，order 116
├── lib/
│   ├── index.js             # Cordis 入口：注册段落 + 注册工具
│   ├── rules.js             # 01 的运行时规则文本（唯一事实来源）
│   └── decide.js            # 02 的固定决策算法（纯函数，可单测）
├── test/
│   ├── decide.test.mjs          # 算法、输出结构、边界
│   └── mandatory-scenarios.test.mjs # 任务要求的 10 个强制场景
├── verify/
│   └── wiring.mjs           # 用真实 Cordis + 真实 defineTool 验证装配
└── node_modules/@deepseek-ai/   # 指向 DSH 的 dsh-tools / schemastery / cordis 链接
```

## 决策算法（固定，不可绕过）

```
QUALITY_IMPACT
  ├─ NONE                → ACTION = MODIFY（选最优方案）
  └─ != NONE
       ├─ USER_IMPACT_IF_UNCHANGED == NONE → ACTION = KEEP_CURRENT
       └─ 否则                              → ACTION = MODIFY（选质量损失最小的替代方案）
```

关键约束：

- 用户提出的具体做法只是**候选方案之一**（`USER_PROPOSED_SOLUTION` ≠ 自动最优）。它必须通过同一组硬性淘汰条件
  （不解决真实问题、无必要地扩大范围、超出许可范围、违反约束、引入更严重副作用、质量损失超过可避免上限、幅度过大）。
- 候选方案按 `02 §8` 的优先级排序：解决真实问题 → 使用体验 → 质量损失更小 → 副作用更少 → 系统一致性 → 稳定性 → 实现复杂度。
- 只有「关键信息缺失 **且** 无法可靠判断 **且** 不同选择导致实质不同结果」时才返回 `INSUFFICIENT_CONTEXT`；
  此时**不得**把用户原始方案当作默认方案执行。

## 安装与生效

```powershell
# 安装（已完成）：把本地包链接进 profile 并加入 dsh.profile.bundles
dsh plugin --profile web add C:\Users\a1941\Desktop\DeepSeek\dsh-confirmation-resolution
```

行由 bundle 补丁 `cordis.patch.yml` 插入宿主组合，因此**需要重启 DSH Web 进程**才会加载
（bundle 层在启动时组合；`dsh.profile.bundles` 变化不会热加载）。

## 验证

```powershell
npm test        # 32 个用例，含 10 个强制场景
npm run verify  # 真实 Cordis 上下文 + 真实 defineTool 的装配验证
npm run check   # 语法 + 测试 + 装配
```

另外两项组合层验证：

```powershell
dsh --profile web --dump-config              # 行出现在组合树中，退出码 0
dsh --profile <临时 profile> --dump-config   # 只装配 tools/system-prompt + 本行，退出码 0 即代表条目已激活
```

`dsh` 启动时会执行 `assertEntriesActivated`：任何一条行无法解析或无法激活都会让整个 profile 启动失败，
因此 `--dump-config` 退出码 0 等价于「该行已成功解析并激活」。

## 卸载

```powershell
dsh plugin --profile web remove dsh-plugin-confirmation-resolution
```

行随 bundle 层一起消失，System Prompt 段落与工具同时下线（两者都是 fiber 作用域的可逆 effect）。
