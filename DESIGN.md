---
name: "Quefa 运营工作台"
description: "以凭证工作簿组织经营、订单、代理与资金的清晰后台"
colors:
  signal: "#245dcc"
  signal-deep: "#194da9"
  night: "#182b43"
  ink: "#25364b"
  secondary: "#506178"
  muted: "#63738a"
  canvas: "#f4f6f9"
  paper: "#fff"
  inset: "#f6f8fb"
  line: "#dce3ec"
  soft-line: "#eaf0f5"
  mint: "#19735c"
  amber: "#946014"
  danger-ink: "#b13943"
  ops-info-surface: "#eff4fd"
  ops-info-line: "#cddbf4"
  ops-success-surface: "#edf7f2"
  ops-success-line: "#cce7d9"
  ops-warning-surface: "#fff7e8"
  ops-warning-line: "#efdab0"
  ops-danger-surface: "#fff1f1"
  ops-danger-line: "#f0cbce"
typography:
  headline:
    fontFamily: "'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-.4px"
  title:
    fontSize: "16px"
    fontWeight: 650
  body:
    fontFamily: "'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
  label:
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "0"
  metric:
    fontSize: "26px"
    fontWeight: 650
    letterSpacing: "-.6px"
  table-amount:
    fontSize: "14px"
    fontWeight: 650
rounded:
  tag: "4px"
  filter: "5px"
  control: "6px"
  surface: "8px"
  dialog: "10px"
spacing:
  micro: "4px"
  compact: "6px"
  tight: "8px"
  control-gap: "12px"
  group: "16px"
  surface: "20px"
  section: "24px"
  workspace-inline: "32px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.signal-deep}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-danger:
    backgroundColor: "{colors.danger-ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  nav-link:
    textColor: "{colors.secondary}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  status-success:
    backgroundColor: "{colors.ops-success-surface}"
    textColor: "{colors.mint}"
    rounded: "{rounded.tag}"
    padding: "3px 7px"
  surface:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.surface}"
    padding: "20px"
  metric-band-item:
    textColor: "{colors.night}"
    typography: "{typography.metric}"
    padding: "20px"
  agent-tab-active:
    textColor: "{colors.signal-deep}"
    padding: "12px 4px"
  wallet-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.night}"
    rounded: "{rounded.surface}"
    padding: "20px"
  dialog:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.dialog}"
---

# Design System: Quefa 运营工作台

## Overview

**Creative North Star: "凭证工作簿"**

“凭证工作簿”把运营后台视为一张可以核对、追溯和继续处理的工作台。纸张白承载内容，蓝灰背景划分空间，深蓝墨水呈现事实，蓝色引导操作。视觉节奏平稳、密度适中，金额、文字状态与下一步动作先于装饰。

本规范依据 2026-10-02 的工作台实现提取，以 src/operations/workspace-styles.ts 末尾的 Operator workspace 覆盖层及实际组件结构为依据。旧 CSS 的前半段保留兼容，未被覆盖的页面、状态和局部样式仍可能使用旧规则；本文件不是所有页面已经完全重写或完成视觉验收的声明。

**Key Characteristics:**

- 蓝灰台面、白色内容面与统一蓝色主操作。
- 金额使用等宽数字，标签与数值有明确层级。
- 分隔线组织记录，语义色主要落在状态和重点数值。
- 日期、凭证与历史按需展开，详情使用居中弹窗。

## Colors

颜色由一个操作蓝、蓝灰中性色及业务语义色组成。具体值以上方 frontmatter 为准，正文说明用途；不另外建立第二套颜色原始值。

.impeccable/design.json 中的八阶色带由原始颜色计算生成，仅用于色彩预览，不代表代码已实现新的色阶变量；组件片段则引用现有 CSS 变量并提供对应回退值。

### Primary

- **操作蓝 signal**：主按钮、可操作焦点和选中指示。
- **深操作蓝 signal-deep**：主按钮悬停、选中导航与信息标签文字。

### Neutral

- **深蓝墨水 night / ink**：标题、重要数值与正文。
- **说明蓝灰 secondary / muted**：字段标签、辅助信息和更新时间；不得用低层级文字隐藏风险提示。
- **蓝灰台面 canvas**：工作区外层背景；**纸张白 paper**：内容面；**浅蓝灰 inset**：表头与嵌入区域。
- **结构线 line / soft-line**：容器边界和记录分隔，后者用于更轻的行间层级。

### 业务语义色

- **核验绿 mint**：成功、已付款、已启用与收益重点数值；浅色面和边界使用对应的 ops-success 配色。
- **待处理琥珀 amber**：待支付、排队与处理中；提示使用对应的 ops-warning 配色。
- **风险红 danger-ink**：失败、待核对及危险确认；提示使用对应的 ops-danger 配色。
- **信息浅蓝 ops-info**：选中筛选、通知与次要资金操作的浅色面和边界。

**The 单一操作蓝 Rule.** 常规主操作使用 signal；风险确认使用 danger-ink。成功、待处理与风险色表达业务状态，不能代替文字标签。

旧兼容规则仍为 running、requested、refunded 等部分状态保留额外配色。新增状态应按业务语义映射，不直接复制历史色值。原有品牌标识中的渐变是既有资产，不扩大到经营与资金容器。

## Typography

主体使用 Segoe UI，中文依次回退到 Microsoft YaHei UI、Microsoft YaHei 和 sans-serif。文字清晰、紧凑，数值比说明更显眼。部分旧页面标题仍保留 Aptos 字体声明；本次没有统一清理这些历史声明。

- **页面标题 headline**：用于工作台页首；窄屏缩小至 22px。
- **分区标题 title**：用于内容组标题，不以大标题挤占表格和待办空间。
- **正文 body**：根字号基准；实际表格和段落组件按信息密度使用 12–14px。
- **标签 label**：用于统计名称；表单标签也使用 12px，按钮与输入为 13px。
- **经营金额 metric**：六项经营带的主要数值；窄屏为 24px，订单汇总为 22px，钱包大额为 28px。
- **订单金额 table-amount**：在独立金额列中加重，保持不换行；下方收款方式为辅助文字。

**The 数字可核对 Rule.** 金额保持 tabular-nums，数值与其含义成组出现；未知、过期与待核实数据必须显示明确说明。

## Layout

桌面工作区由 208px 导航栏与剩余宽度内容区组成。内容不设固定最大宽度，默认内边距为上 28px、左右 32px、下 56px。标题与正文区域之间留 24px；常规容器内留 20px，记录组常用 16px。表格负责密集数据，完整历史和凭证在详情中逐层呈现。

| 区域 | 桌面布局 | 收窄行为 |
| --- | --- | --- |
| 首页经营带 | 六项等宽连续单元，细线分隔 | ≤1180px 三列；≤720px 两列 |
| 首页待办 | 两列记录分组 | ≤1180px 一列 |
| 平台订单统计 | 匹配订单、已付款、已付款金额、今日已付、今日收款，共五项 | ≤720px 两列 |
| 订单筛选 | 搜索优先，代理与套餐并列；日期另行展开 | ≤1180px 搜索占整行；≤720px 单列表单 |
| 日期字段 | 四个日期与可选清除操作并列 | ≤720px 两列 |
| 资金卡片 | 两列 | ≤720px 一列 |
| 代理摘要 | 连续事实单元 | ≤720px 两列 |

中等宽度（≤1180px）主内容改为 24px 内边距；手机（≤720px）改为上 20px、左右 16px、下 48px，并切换为单列壳层和可展开导航。页内导航沿文档流排列；代理页签可横向滚动。

订单表格保留“单号 / 时间、所属代理商、套餐、金额、支付、履约、操作”的独立列；代理视角省去所属代理商。订单主列表实际受更高特异性的容器规则影响，最小宽度为 760px；样式中另有 980px 的订单表规则，不能将其概括为所有列表的统一宽度。窄屏使用容器横向滚动。经营六列与订单五项是各自页面约定，不强制用于所有统计组件。

## Elevation & Depth

经营带、待办、订单与资金容器使用底色和细线区分；投影用于弹窗层级，不为普通卡片增加浮起效果。

- **弹窗投影**：`0 20px 80px #182b432b`，与半透明背景遮罩共同区分当前任务。
- **输入聚焦**：`0 0 0 3px #245dcc12`，配合操作蓝边界。
- **选中导航**：内侧 2px 蓝色标记；经营带悬停使用内侧底部 2px 蓝色标记。
- **键盘焦点**：按钮、链接和 summary 为 2px 操作蓝外框，偏移 3px；输入仍同时继承旧版 3px `#719fd9` 外框，不能声称全站焦点已完全统一。

**The 平面优先 Rule.** 经营带、待办、订单与资金容器使用底色和细线区分；投影用于弹窗层级，不为普通卡片增加浮起效果。

弹窗入场为 160ms ease-out，由下方 8px 和较低透明度进入。常规按钮只对背景、边框和文字颜色做 120ms 过渡，不缩放或跳起。减少动态效果偏好将过渡与动画缩短至 .01ms，并关闭平滑滚动。兼容区域的历史动效不属于新界面的默认语法。

## Shapes

控件为轻微圆角矩形，内容面与弹窗按层级略增圆角。标签、筛选、控件、内容面和弹窗的尺度以 frontmatter 为准。经营带单元为相连直角分区，代理页签使用平直底线，避免用全胶囊轮廓包装每项信息。

普通容器使用 1px 结构线。订单表格用横向细分隔线和浅底表头；状态标签紧凑、文字明确。连续单元共享边界，避免重复边框造成视觉加粗。

## Components

### 按钮与输入

常规按钮最小高度 40px；主按钮使用操作蓝，次按钮为白底边框，危险确认可用风险红实底。禁用状态保留低透明度与不可用光标。按钮悬停改变颜色，不增加位移。表格中的详情按钮为 36px，复制类紧凑按钮可为 32px；这些是既有密度例外，不代表全站统一触控尺寸。

输入、选择器与文本域最小高度 40px，标签在上方，聚焦显示明确边界与光圈。新表单保留字段名、必填和错误说明，不能仅靠占位符解释用途。输入错误与禁用细节继续依从各业务表单现有实现，本规范不宣称它们已全面统一。

### 状态、筛选与表格

状态标签采用浅色背景与同语义文字，不可仅以颜色传达支付、履约或风险。状态筛选采用低对比静止态与浅蓝选中态。订单金额单独成列，支付与履约也分别成列；履约说明允许换行。

日期筛选使用原生 details：无日期条件时折叠，已设置任一日期条件时展开并标记“已设置”；清除后恢复未设置状态。列表为空时显示文字说明和调整筛选建议，不能用空白容器暗示加载成功。

### 经营带与待办

首页六项经营数值共用一个连续工作面，标签在上、数值在下，桌面单元最小高度 104px，手机 88px。可点击项悬停以浅底和底线反馈，不制作独立悬浮卡片。

待办使用白底分组和浅灰表头。记录之间用细线分隔；风险主要由计数、状态文字和必要警示表达，不将整组涂满强烈颜色。有待办的分组默认展开，每类先显示最多四条，计数仍表示全量；正常处理中的内容默认折叠。正常状态与次要运行信息保持较低视觉权重。

### 导航与代理集中管理

主导航使用浅底选中态和左侧蓝色细线。代理详情使用底线页签，选中项为深操作蓝加 2px 底线，最小高度 44px。当前分区依次为代理概览、订单履约、资金佣金、开票记录、账号权限、接口能力、合作设置、售后记录。保留同一代理上下文，避免在各分区重新选择代理。

### 资金容器

采购与收益卡片统一采用白底细线，最小高度 128px。金额为 28px，收益重点数值可用核验绿；解释文字用蓝灰，操作使用浅蓝按钮。资金分区选择器和提示区同样采用低饱和底色。保留手续费、待核、退款去向与到账说明，不以视觉精简替代资金语义。

### 居中详情与逐层展开

详情使用原生 dialog，并保留原有键盘、关闭和返回焦点行为。普通弹窗宽度为 `min(960px, calc(100vw - 64px))`，内容最高为 `min(88svh, 920px)`；手机宽度为视口减 24px，内容最高为视口高度减 24px。标题区与可滚动内容区分离，手机内容内边距为 16px。订单详情和确认弹窗存在历史宽度类，具体结果以 CSS 层叠与运行页面为准。

订单标识与收款凭证、履约记录、退款历史、审计和人工完成记录默认折叠。可执行的人工审核与订单动作可自动展开；刷新保留已有展开状态与滚动位置。风险提示和当前进度仍直接可见。组件预览只展示外观，不模拟真实交易、业务校验或完整弹窗生命周期。

## Do's and Don'ts

### Do:

- Do 保留 Quefa 名称和既有标识，使用本文件的颜色角色和字号层级。
- Do 将金额、支付状态、履约状态分别呈现，并为状态提供文字。
- Do 在桌面保留六项经营带；订单页使用独立五项统计，移动端按已实现断点重排。
- Do 让次要凭证与历史默认折叠，同时保留当前可执行动作、风险提示和已设置的筛选条件。
- Do 保持居中详情弹窗、可见焦点、内容滚动及已有关闭后焦点返回行为。
- Do 在新增界面中复用统一蓝色主操作、细分隔线和低饱和资金容器。

### Don't:

- Don't 用大面积高饱和色块、渐变或卡片浮起效果包装经营数据和资金卡片。
- Don't 把金额、支付和履约合并成一个难以扫描的状态列。
- Don't 为压缩界面删除危险操作确认、待核锁、未知结果保护或收费说明。
- Don't 把未知或失效数据解释成零、正常或已完成。
- Don't 将兼容层中尚未迁移的颜色、圆角和局部动效当作新增页面的默认规范。
- Don't 将本文的代码提取范围描述为全站已重写、所有状态已验收或生产已经部署。
