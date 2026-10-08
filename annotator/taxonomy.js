/** Intention taxonomy for SWE-chat user-prompt annotation (IR-02). */
window.IR02_TAXONOMY = [
  {
    id: "understand",
    name: "Understand",
    key: "1",
    core: "弄清现状、原因或可行性",
    definition:
      "The user seeks to learn what is true, why something happens, or whether a specific action can work.",
    note: "用户只贴错误代码、几乎无其他说明 → 倾向 understand",
  },
  {
    id: "decide",
    name: "Decide",
    key: "2",
    core: "询问要采取哪些行动，或是否采取行动",
    definition:
      "The user seeks to choose what to do, which approach to take, or what to prioritize.",
    note: "在方案/优先级之间做选择，尚未给出明确执行指令",
  },
  {
    id: "execute",
    name: "Execute",
    key: "3",
    core: "已有清晰下一步，要 AI 落地或给出执行说明",
    definition:
      "The user seeks to carry out a specified next step or obtain the instructions needed to do it.",
    note: "包括修改或不修改代码的执行类请求",
  },
  {
    id: "realign",
    name: "Realign",
    key: "4",
    core: "纠正此前已约定的任务框架或方向",
    definition:
      "The user seeks to correct the task understanding or direction that has guided the collaboration so far.",
    note: "需已有旧框架（含义/范围/成功标准/路线/分工），且有纠正、撤回、否定或重述",
  },
];
