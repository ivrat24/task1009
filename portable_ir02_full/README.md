# IR-02 人工打标工作台（双人双机）

面向 SWE-chat 类 transcripts：整理杂乱原始会话 → 按 **User prompt** 打四类意图 → 导航浏览 → 导出 Excel / 双机交接 JSON。

## 意图类别

| ID | 判断核心 |
|----|----------|
| `understand` | 弄清现状 / 原因 / 可行性；只贴错代码倾向此类 |
| `decide` | 问做什么、怎么做、优先什么 |
| `execute` | 已有清晰下一步，要落地或执行说明 |
| `realign` | 纠正此前已定的任务框架 / 方向 |

## 双人双机推荐流程

两台电脑各跑一份 portable / 本仓库界面，**不要共用同一个浏览器配置文件**。

1. **身份**  
   - 机器 A：标注员选 `A`，机器 ID 填如 `desk-A`  
   - 机器 B：标注员选 `B`，机器 ID 填如 `desk-B`
2. **任务范围**选「仅我的分片」  
   - 会话按 `session_id` 稳定哈希分给 A/B（两机算法相同，互不重叠）  
   - 需要偷看对方分片时用「仅对方分片（只读）」
3. **日常标注**  
   - 用「下一条未标注」只在自己分片内跳转  
   - 阶段性点「导出标注」，文件名形如 `ir02_A_desk-A_<时间>_state.json`，建议放进 `labels\`
4. **交换与一致性**  
   - 把 JSON 拷到另一台  
   - 对方点「导入对方(对比)」（**不会**覆盖本机槽位）→「一致性」看一致率 / 导出分歧  
   - 「导入/合并标注」只用于**恢复自己进度**或明确要把文件并进当前槽位
5. **Gold**  
   - 对齐讨论后用标注员 `gold` 槽位写共识；导出单独保存

页顶「复制交接说明」可一键复制上述要点。

## 打标界面

```bat
START.bat
```

打开 http://127.0.0.1:8765/annotator/

- 对话区默认渲染 **Markdown + LaTeX**（KaTeX；可在「意图分类」标题旁关闭）
- 支持 `$...$` / `$$...$$` / `\(...\)` / `\[...\]`
- 依赖全部在 `annotator/vendor/`，**不需要外网 CDN**

### 整包转移（换电脑仍可用）

```bat
scripts\pack_portable.bat
```

会生成 `portable_ir02_annotator\` 与 `portable_ir02_annotator.zip`（含界面、vendor、100 条抽样数据）。

**标注进度默认在浏览器 localStorage，不会随文件夹自动带走。** 转移前：

1. 点「导出标注」保存 JSON（建议 `labels\`）
2. 带走整个 portable 包 + 该 JSON  
3. 新机器 `START.bat` → 选对标注员 / 机器 ID →「导入/合并标注」

Excel / JSONL 用于分析；「导出标注」JSON 用于恢复与双机对比。

## 导入 SWE-chat 完整数据（推荐）

数据源（gated）：[SALT-NLP/SWE-chat](https://huggingface.co/datasets/SALT-NLP/SWE-chat/tree/main/transcripts)

1. 浏览器登录 Hugging Face，打开上述页面并 **Accept** 访问条款  
2. 本机登录：`hf auth login`  
3. **推荐**：拉 parquet 表并整理（远快于逐个 transcripts jsonl）：

```bat
python scripts/import_swe_chat_parquet.py
```

会下载 `conversations.parquet`（约 1.3GB）并生成：
- `data/cleaned/sessions.jsonl`
- `data/cleaned/sessions.js`
- `data/cleaned/index.json`

当前全量整理结果约：**5795 sessions / 62544 user prompts**（仅保留 conversational turns）。

备选：逐文件拉 transcripts（慢，可断点续传）：

```bat
python scripts/download_swe_chat.py --all
python scripts/download_swe_chat.py --limit 100 --seed 42
```

> 浏览器若卡顿：不要一次加载全量 `sessions.js`。在打标页用右上角导入，或先用脚本抽样一小批再导入。

## 界面说明

- **左侧**：会话列表（带 A/B 分片标记）→ 当前会话 User prompts → 意图分类
- **右侧**：完整对话；当前待标 prompt 高亮
- **标注员 A/B/gold**：分槽保存在本机 `localStorage`，互不覆盖
- **机器 ID / 任务范围**：服务双机分片与导出溯源
- **导出 Excel**：一行一个 User prompt（含 intention / uncertain / note / machine_id / session_owner）

## 快捷键

| 键 | 作用 |
|----|------|
| `1`–`4` | understand / decide / execute / realign |
| `S` | 保存并下一条 |
| `←` `→` | 上/下一条 prompt |
| `U` | 下一条未标注（限当前任务范围） |
| `[` `]` | 上/下会话（限当前任务范围） |

## 建议标注流程（双人）

1. 先各用「仅我的分片」熟悉界面；可抽少量重叠会话做对齐（临时改「全部」）  
2. 正式阶段两人只标自己分片，定期交换 `_state.json`  
3. 「导入对方(对比)」+「一致性」算一致率，导出分歧讨论  
4. 商讨结果写入 `gold` 槽并导出  
5. 再做 LLM × 提示语评测（本仓库下一步）
