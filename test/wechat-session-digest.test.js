import test from "node:test"
import assert from "node:assert/strict"

import {
  buildSessionDigest,
  groupPermissionsBySession,
  groupQuestionsBySession,
  pickRecentSessions,
} from "../dist/wechat/session-digest.js"

test("groupQuestionsBySession/groupPermissionsBySession 使用真实请求结构按 sessionID 分桶", () => {
  const questions = [
    { id: "q-1", sessionID: "s-1", text: "需要继续吗？" },
    { id: "q-2", sessionID: "s-2", text: "是否重试？" },
    { id: "q-3", sessionID: "s-1", text: "是否保留改动？" },
  ]
  const permissions = [
    { id: "p-1", sessionID: "s-2", tool: "bash", command: "rm" },
    { id: "p-2", sessionID: "s-1", tool: "edit", command: "write" },
  ]

  const qBuckets = groupQuestionsBySession(questions)
  const pBuckets = groupPermissionsBySession(permissions)

  assert.equal(qBuckets instanceof Map, true)
  assert.equal(pBuckets instanceof Map, true)
  assert.equal(qBuckets.get("s-1")?.length, 2)
  assert.equal(qBuckets.get("s-2")?.length, 1)
  assert.equal(pBuckets.get("s-1")?.length, 1)
  assert.equal(pBuckets.get("s-2")?.length, 1)
})

test("buildSessionDigest: permission/question/tool/todo/status 可并行展示且顺序固定", () => {
  const session = {
    id: "session-1",
    title: "修复状态聚合",
    directory: "/repo/a",
    time: {
      updated: 1710000001000,
    },
  }

  const digest = buildSessionDigest({
    session,
    statusBySession: {
      "session-1": { type: "busy" },
    },
    questionsBySession: groupQuestionsBySession([
      {
        id: "question-request-1",
        sessionID: "session-1",
        text: "是否继续执行下一步？",
      },
    ]),
    permissionsBySession: groupPermissionsBySession([
      {
        id: "permission-request-1",
        sessionID: "session-1",
        tool: "bash",
        command: "git push",
      },
    ]),
    todos: [
      { id: "todo-1", content: " 发布 release 草稿 ", status: "pending" },
      { id: "todo-2", content: "等待 npm 发布", status: "in_progress" },
      { id: "todo-3", content: "更新 README", status: "completed" },
      { id: "todo-4", content: "已取消的迁移任务", status: "cancelled" },
    ],
    messages: [
      {
        info: {
          id: "msg-1",
          sessionID: "session-1",
        },
        parts: [
          {
            id: "part-running",
            type: "tool",
            tool: "bash",
            state: { status: "running" },
          },
          {
            id: "part-completed",
            type: "tool",
            tool: "todowrite",
            state: { status: "completed" },
          },
          {
            id: "part-question-tool",
            type: "tool",
            tool: "question",
            state: { status: "completed" },
          },
        ],
      },
    ],
  })

  assert.equal(digest.pendingPermissionCount, 1)
  assert.equal(digest.pendingQuestionCount, 1)
  assert.equal(digest.todoSummary.total, 4)
  assert.equal(digest.todoSummary.inProgress, 1)
  assert.equal(digest.todoSummary.completed, 1)
  assert.deepEqual(digest.todoItems, [
    { status: "pending", content: "发布 release 草稿" },
    { status: "in_progress", content: "等待 npm 发布" },
    { status: "completed", content: "更新 README" },
    { status: "cancelled", content: "已取消的迁移任务" },
  ])
  assert.deepEqual(digest.questionHighlights, ["问题：是否继续执行下一步？"])

  const kinds = digest.highlights.map((item) => item.kind)
  assert.deepEqual(kinds, [
    "permission",
    "question",
    "running-tool",
    "completed-tool",
    "todo",
    "status",
  ])

  const runningTool = digest.highlights.find((item) => item.kind === "running-tool")
  const completedTool = digest.highlights.find((item) => item.kind === "completed-tool")
  const statusSlice = digest.highlights[digest.highlights.length - 1]

  assert.equal(runningTool.text.includes("bash"), true)
  assert.equal(completedTool.text.includes("question"), true)
  assert.equal(completedTool.text.includes("todowrite"), false)
  assert.equal(statusSlice.kind, "status")
  assert.equal(statusSlice.text.includes("busy"), true)
})

test("pickRecentSessions: 仅返回最近活跃的前三个 session", () => {
  const sessions = [
    { id: "s-1", time: { updated: 100 } },
    { id: "s-2", time: { updated: 400 } },
    { id: "s-3", time: { updated: 300 } },
    { id: "s-4", time: { updated: 200 } },
  ]

  const picked = pickRecentSessions(sessions, 3)
  assert.deepEqual(
    picked.map((session) => session.id),
    ["s-2", "s-3", "s-4"],
  )
})

test("buildSessionDigest: status 始终作为尾部切片存在，不覆盖前序切片", () => {
  const digest = buildSessionDigest({
    session: {
      id: "session-2",
      title: "并发任务",
      directory: "/repo/b",
      time: { updated: 1710000002000 },
    },
    statusBySession: {
      "session-2": { type: "retry", attempt: 2, message: "rate limited", next: 1710000003000 },
    },
    questionsBySession: groupQuestionsBySession([
      {
        id: "question-request-2",
        sessionID: "session-2",
        text: "是否继续重试？",
      },
    ]),
    permissionsBySession: groupPermissionsBySession([
      {
        id: "permission-request-2",
        sessionID: "session-2",
        tool: "edit",
        command: "update file",
      },
    ]),
    todos: [],
    messages: [],
  })

  assert.equal(digest.highlights[0].kind, "permission")
  assert.equal(digest.highlights[1].kind, "question")
  assert.equal(digest.highlights[digest.highlights.length - 1].kind, "status")
  assert.equal(digest.highlights[digest.highlights.length - 1].text.includes("retry"), true)
})
