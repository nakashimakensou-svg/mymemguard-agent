#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const readline = require('readline')

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.mymemguard')
const CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return null }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiFetch(url, method, body, token) {
  const { default: fetch } = await import('node-fetch')
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const IGNORE = ['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.turbo']

function buildTree(dir, depth, maxDepth) {
  if (depth > maxDepth) return []
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter(e => !IGNORE.includes(e.name) && !e.name.startsWith('.'))
    .map(e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return { name: e.name, type: 'dir', children: buildTree(full, depth + 1, maxDepth) }
      return { name: e.name, type: 'file', size: fs.statSync(full).size }
    })
}

function treeToText(nodes, prefix = '') {
  return nodes.map((n, i) => {
    const isLast = i === nodes.length - 1
    const branch = isLast ? '└── ' : '├── '
    const childPrefix = prefix + (isLast ? '    ' : '│   ')
    const line = prefix + branch + n.name + (n.type === 'dir' ? '/' : ` (${n.size}B)`)
    return n.type === 'dir' && n.children?.length
      ? line + '\n' + treeToText(n.children, childPrefix)
      : line
  }).join('\n')
}

// ─── Context persistence ──────────────────────────────────────────────────────

function getContextFile(cwd) {
  const hash = require('crypto').createHash('md5').update(cwd).digest('hex').slice(0, 8)
  return path.join(CONFIG_DIR, `context-${hash}.json`)
}

function loadProjectContext(cwd) {
  try {
    const data = JSON.parse(fs.readFileSync(getContextFile(cwd), 'utf8'))
    if (data.cwd === cwd) return data
  } catch { /* no context yet */ }
  return null
}

function saveProjectContext(cwd, summary) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const existing = loadProjectContext(cwd) || {}
  fs.writeFileSync(getContextFile(cwd), JSON.stringify({ ...existing, cwd, summary, updatedAt: new Date().toISOString() }, null, 2))
}

// ─── Phase management (探索→計画→確認→実行) ──────────────────────────────────

function savePhase(cwd, phaseData) {
  const file = getContextFile(cwd)
  let data = {}
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  data.phase = { ...data.phase, ...phaseData, updatedAt: new Date().toISOString() }
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function loadPhase(cwd) {
  try {
    const data = JSON.parse(fs.readFileSync(getContextFile(cwd), 'utf8'))
    if (!data.phase) return null
    const age = Date.now() - new Date(data.phase.updatedAt || 0).getTime()
    if (age > 60 * 60 * 1000) return null  // 1時間で期限切れ
    return data.phase
  } catch {}
  return null
}

function clearPhase(cwd) {
  try {
    const file = getContextFile(cwd)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete data.phase
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch {}
}

// ─── Work Journal (作業ジャーナル) ────────────────────────────────────────────

function appendJournal(cwd, entry) {
  try {
    const file = getContextFile(cwd)
    let data = {}
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (!data.phase) return
    if (!data.phase.workJournal) data.phase.workJournal = []
    data.phase.workJournal.push(`[${new Date().toLocaleTimeString('ja-JP')}] ${entry}`)
    if (data.phase.workJournal.length > 100) data.phase.workJournal = data.phase.workJournal.slice(-100)
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch {}
}

function getJournal(cwd) {
  try {
    const data = JSON.parse(fs.readFileSync(getContextFile(cwd), 'utf8'))
    return data.phase?.workJournal || []
  } catch { return [] }
}

// ─── Stream helpers ───────────────────────────────────────────────────────────

async function postStream(cfg, commandId, streamLog) {
  if (!commandId) return
  try {
    await apiFetch(`${cfg.url}/api/agent/stream`, 'POST', { command_id: commandId, stream_log: streamLog }, cfg.token)
  } catch { /* ignore stream errors — not critical */ }
}

async function postConfirmPrompt(cfg, commandId, confirmPrompt, streamLog) {
  if (!commandId) return
  try {
    await apiFetch(`${cfg.url}/api/agent/stream`, 'POST', { command_id: commandId, confirm_prompt: confirmPrompt, stream_log: streamLog }, cfg.token)
  } catch { /* ignore */ }
}

// Agent polls for user's confirm_response
async function waitForConfirmation(cfg, commandId, command) {
  if (!commandId) return true
  const prompt = `⚠️ 危険な操作の確認:\n\`${command}\`\n\nこのコマンドを実行してもよいですか？`
  console.log(`   ⚠️  確認が必要: ${command}`)
  await postConfirmPrompt(cfg, commandId, prompt, `⏳ ユーザーの確認待ち...\n実行予定: ${command}`)

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const { default: fetch } = await import('node-fetch')
      const res = await fetch(`${cfg.url}/api/agent/stream?id=${commandId}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
      })
      const data = await res.json()
      if (data.confirm_response === 'approved') {
        console.log(`   ✅ ユーザーが承認`)
        return true
      }
      if (data.confirm_response === 'rejected') {
        console.log(`   ❌ ユーザーが拒否`)
        return false
      }
    } catch { /* retry */ }
  }
  console.log(`   ⏱ タイムアウト — キャンセル`)
  return false
}

// ─── Gemini direct call ───────────────────────────────────────────────────────

const GEMINI_URL = (key) => `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`

// ─── Claude API (tool use) ────────────────────────────────────────────────────

const CLAUDE_MODELS = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
}

const CLAUDE_TOOLS = [
  {
    name: 'exec_command',
    description: 'Windowsのcmd.exeでシェルコマンドを実行する。ファイル削除・作成・ビルドなどに使う。括弧やスペースを含むパスはダブルクォートで囲む。',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
  },
  {
    name: 'read_file',
    description: 'ファイルの内容を読む。大きいファイルは自動的に分割される。続きがある場合は has_more=true と next_offset が返るので read_file_chunk で続きを読むこと。',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'read_file_chunk',
    description: 'read_file で has_more=true だった場合に続きを読む。offset に next_offset の値を指定する。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'ファイルパス' },
        offset: { type: 'number', description: '読み始める文字位置（read_fileのnext_offsetの値）' },
      },
      required: ['path', 'offset']
    }
  },
  {
    name: 'write_file',
    description: 'ファイルを書き込む（作成・上書き）',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'list_dir',
    description: 'ディレクトリの中身一覧を取得',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'grep_search',
    description: 'プロジェクト内のファイルをキーワード・正規表現で全文検索する。バグの場所・関数の定義・import元などを探すときに使う。数千ファイルでも高速。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '検索キーワードまたは正規表現（例: "useState", "export function handleLogin"）' },
        file_pattern: { type: 'string', description: '対象ファイルの拡張子フィルタ（例: "*.ts", "*.tsx", "*.js"）省略時は全テキストファイル' },
        case_sensitive: { type: 'boolean', description: '大文字小文字を区別するか（デフォルト: false）' },
        max_results: { type: 'number', description: '最大結果数（デフォルト: 50）' },
      },
      required: ['pattern']
    }
  },
  {
    name: 'glob_files',
    description: 'ファイル名・パスのパターンでファイルを検索する。「全部の.tsxファイル」「componentsフォルダ以下のファイル」などを探すときに使う。数千ファイルでも高速。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'globパターン（例: "**/*.ts", "src/components/**/*.tsx", "**/*.test.js"）' },
        max_results: { type: 'number', description: '最大結果数（デフォルト: 100）' },
      },
      required: ['pattern']
    }
  },
  {
    name: 'web_search',
    description: 'インターネットで情報を検索する。最新情報・技術ドキュメント・エラーの解決策・ライブラリの使い方などを調べるときに使う。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索クエリ（例: "Next.js 15 App Router tutorial", "TypeError cannot read property undefined fix"）' },
        max_results: { type: 'number', description: '最大結果数（デフォルト: 5）' },
      },
      required: ['query']
    }
  },
]

// Dangerous command patterns that require user confirmation
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sf]\b/i,
  /\bformat\b/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\s+.*--force\b/i,
  /Remove-Item\s+.*-Recurse/i,
  /Remove-Item\s+.*-Force/i,
  /\bri\s+.*-r/i,
]

// ビルドキャッシュ・一時フォルダは削除しても安全
const SAFE_DELETE_PATTERNS = [
  /rmdir.*\\\.next\b/i,
  /rmdir.*\/\.next\b/i,
  /rmdir.*(\\|\/)(dist|build|out|coverage|\.turbo|\.cache)\b/i,
  /Remove-Item.*(\.next|dist|build|out|coverage)\b/i,
]

function isDangerous(command) {
  if (SAFE_DELETE_PATTERNS.some(p => p.test(command))) return false
  return DANGEROUS_PATTERNS.some(p => p.test(command))
}

async function callClaudeWithTools(anthropicKey, systemPrompt, history, message, model, cwd, cfg, commandId, onRoundComplete) {
  const { default: fetch } = await import('node-fetch')
  const messages = [
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    { role: 'user', content: message },
  ]

  let streamLog = '🤖 Claude 起動中...'
  await postStream(cfg, commandId, streamLog)
  let accumulatedText = '' // テキストを全ラウンドで蓄積

  const maxRounds = (CLAUDE_MODELS[model] === CLAUDE_MODELS.sonnet) ? 25 : 15
  for (let round = 0; round < maxRounds; round++) {
    let data
    for (let retry = 0; retry < 3; retry++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CLAUDE_MODELS[model] || CLAUDE_MODELS.haiku, max_tokens: 8192, system: systemPrompt, tools: CLAUDE_TOOLS, messages }),
      })
      data = await res.json()
      if (data.error?.type === 'rate_limit_error') {
        const wait = (retry + 1) * 20000 // 20s, 40s, 60s
        console.log(`   ⏳ レート制限 — ${wait / 1000}秒待機して再試行...`)
        streamLog += `\n⏳ レート制限 — ${wait / 1000}秒待機中...`
        await postStream(cfg, commandId, streamLog)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      break
    }
    if (data.error) throw new Error(`Claude error: ${data.error.message}`)

    const toolUses = data.content?.filter(b => b.type === 'tool_use') || []
    const textBlocks = data.content?.filter(b => b.type === 'text') || []

    // テキストを蓄積（ツール呼び出しと同時に返ってくる場合も捨てない）
    if (textBlocks.length > 0) {
      accumulatedText = textBlocks.map(b => b.text).join('')
    }

    if (data.stop_reason === 'end_turn' || toolUses.length === 0) {
      const answer = accumulatedText || '（応答なし）'
      await postStream(cfg, commandId, streamLog + '\n✅ 回答生成完了')
      return answer
    }

    // ─── Execute tool calls IN PARALLEL (max 4 at a time to avoid rate limits) ─
    messages.push({ role: 'assistant', content: data.content })

    const toolNames = toolUses.map(b => `${b.name}(${JSON.stringify(b.input).slice(0, 60)})`).join(', ')
    streamLog += `\n🔧 [Round ${round + 1}] ${toolNames}`
    console.log(`   🔧 並列実行: ${toolNames}`)
    await postStream(cfg, commandId, streamLog)

    async function executeTool(block) {
      const { name, input, id } = block
      let result
      try {
        if (name === 'exec_command') {
          // ─── Safety confirmation (feature 2) ───────────────────────────────
          if (isDangerous(input.command)) {
            const approved = await waitForConfirmation(cfg, commandId, input.command)
            if (!approved) {
              result = '❌ ユーザーがこの操作を明示的に拒否しました。同じ目的の別コマンドを試みることも禁止されています。ユーザーに拒否された旨を報告して処理を終了してください。'
              return { type: 'tool_result', tool_use_id: id, content: result }
            }
            await postStream(cfg, commandId, streamLog + '\n▶️ 承認済み — 実行中...')
          }
          const r = handleExec({ command: input.command, cwd })
          result = `exit:${r.exitCode}\nstdout: ${r.stdout.slice(0, 4000)}\n${r.stderr ? 'stderr: ' + r.stderr.slice(0, 2000) : ''}`.trim()
          if (r.exitCode !== 0) {
            result += '\n\n[HINT: コマンドが失敗しました。エラー内容を分析して、修正コマンドを実行してください。]'
          }
        } else if (name === 'read_file') {
          const safe = resolveSafe(cwd, input.path)
          if (safe.error) { result = safe.error } else {
            const r = handleReadFile({ path: safe.resolved })
            result = r.error || (r.content + (r.has_more ? `\n\n${r.note}` : ''))
          }
        } else if (name === 'read_file_chunk') {
          const safe = resolveSafe(cwd, input.path)
          if (safe.error) { result = safe.error } else {
            const r = handleReadFileChunk({ path: safe.resolved, offset: input.offset })
            result = r.error || (r.content + (r.has_more ? `\n\n${r.note}` : `\n\n${r.note}`))
          }
        } else if (name === 'write_file') {
          const safe = resolveSafe(cwd, input.path)
          if (safe.error) { result = safe.error } else {
            const r = handleWriteFile({ path: safe.resolved, content: input.content })
            result = r.ok ? '✓ 書き込み完了' : r.error
          }
        } else if (name === 'list_dir') {
          const safe = resolveSafe(cwd, input.path)
          if (safe.error) { result = safe.error } else {
            const r = handleListDir({ path: safe.resolved })
            result = r.entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n')
          }
        } else if (name === 'grep_search') {
          result = handleGrepSearch(input, cwd)
        } else if (name === 'glob_files') {
          result = handleGlobFiles(input, cwd)
        } else if (name === 'web_search') {
          result = await handleWebSearch(input)
        }
      } catch (e) {
        result = `エラー: ${e.message}`
        console.log(`   ❌ ${name}: ${e.message}`)
      }
      return { type: 'tool_result', tool_use_id: id, content: String(result) }
    }

    // Chunk parallel execution to max 4 at a time
    const PARALLEL_LIMIT = 4
    const toolResults = []
    for (let j = 0; j < toolUses.length; j += PARALLEL_LIMIT) {
      const chunk = toolUses.slice(j, j + PARALLEL_LIMIT)
      const chunkResults = await Promise.all(chunk.map(executeTool))
      toolResults.push(...chunkResults)
    }

    const doneNames = toolUses.map(b => b.name).join(', ')
    streamLog += ` ✓`
    console.log(`   ✓ 完了: ${doneNames}`)
    await postStream(cfg, commandId, streamLog)

    // ジャーナルに記録
    if (onRoundComplete) {
      const summary = toolUses.map(b => `${b.name}(${JSON.stringify(b.input).slice(0, 50)})`).join(', ')
      onRoundComplete(summary)
    }

    messages.push({ role: 'user', content: toolResults })

    // ─── Prune old tool rounds to prevent token accumulation ─────────────────
    if (messages.length > 20) {
      // Take last 16 messages, ensuring tail starts with an assistant message
      // to avoid orphaned tool_result blocks without a preceding tool_use
      let tail = messages.slice(-16)
      while (tail.length > 0 && tail[0].role !== 'assistant') {
        tail = tail.slice(1)
      }
      // Merge summary into the first user message to avoid consecutive user messages
      const droppedCount = messages.length - 1 - tail.length
      const summaryPrefix = `[以前の作業: ${droppedCount}メッセージを省略。]\n\n`
      const firstContent = typeof messages[0].content === 'string' ? messages[0].content : JSON.stringify(messages[0].content)
      messages.length = 0
      messages.push({ role: 'user', content: summaryPrefix + firstContent }, ...tail)
    }
  }
  return accumulatedText || '（最大ラウンド数に達しました — エラーが複雑なため途中で終了しました）'
}

async function callGemini(geminiKey, systemPrompt, history, message) {
  const contents = [
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ]
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
  }
  const data = await apiFetch(GEMINI_URL(geminiKey), 'POST', body, null)
  if (data.error) throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`)
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '（Geminiから応答がありませんでした）'
}

// Gemini Function Calling でツールを使いながら会話するエージェントループ
async function callGeminiWithTools(geminiKey, systemPrompt, history, message, cwd) {
  const tools = [{
    functionDeclarations: [
      {
        name: 'exec_command',
        description: 'Windowsのcmd.exeでシェルコマンドを実行する。ファイル削除・作成・ビルドなどに使う。',
        parameters: { type: 'OBJECT', properties: { command: { type: 'STRING', description: 'cmd.exeで実行するコマンド。括弧やスペースを含むパスはダブルクォートで囲む。' } }, required: ['command'] }
      },
      {
        name: 'read_file',
        description: 'ファイルの内容を読む。has_more=trueなら read_file_chunk で続きを読む。',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] }
      },
      {
        name: 'read_file_chunk',
        description: 'read_fileの続きを読む。offsetにnext_offsetの値を指定する。',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, offset: { type: 'NUMBER' } }, required: ['path', 'offset'] }
      },
      {
        name: 'write_file',
        description: 'ファイルを書き込む（作成・上書き）',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['path', 'content'] }
      },
      {
        name: 'list_dir',
        description: 'ディレクトリの中身一覧を取得',
        parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] }
      },
      {
        name: 'grep_search',
        description: 'プロジェクト内のファイルをキーワード・正規表現で全文検索する',
        parameters: { type: 'OBJECT', properties: { pattern: { type: 'STRING' }, file_pattern: { type: 'STRING' }, case_sensitive: { type: 'BOOLEAN' }, max_results: { type: 'NUMBER' } }, required: ['pattern'] }
      },
      {
        name: 'glob_files',
        description: 'ファイル名・パスのパターンでファイルを検索する',
        parameters: { type: 'OBJECT', properties: { pattern: { type: 'STRING' }, max_results: { type: 'NUMBER' } }, required: ['pattern'] }
      },
      {
        name: 'web_search',
        description: 'インターネットで情報を検索する。最新情報・技術ドキュメント・エラーの解決策などを調べるときに使う。',
        parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: '検索クエリ' }, max_results: { type: 'NUMBER' } }, required: ['query'] }
      },
    ]
  }]

  const contents = [
    ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ]

  for (let round = 0; round < 5; round++) {
    const isLastTurn = contents[contents.length - 1]?.parts?.some(p => p.functionResponse)
    const toolConfig = isLastTurn
      ? { function_calling_config: { mode: 'AUTO' } }
      : { function_calling_config: { mode: 'ANY' } }
    const body = { system_instruction: { parts: [{ text: systemPrompt }] }, contents, tools, tool_config: toolConfig, generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } }
    const data = await apiFetch(GEMINI_URL(geminiKey), 'POST', body, null)
    if (data.error) throw new Error(`Gemini error: ${data.error.message}`)

    const candidate = data.candidates?.[0]
    if (!candidate) throw new Error('No candidate returned')

    const parts = candidate.content?.parts || []
    const toolCalls = parts.filter(p => p.functionCall)
    const textParts = parts.filter(p => p.text)

    if (toolCalls.length === 0) {
      return textParts.map(p => p.text).join('') || '（応答なし）'
    }

    contents.push({ role: 'model', parts })
    const toolResults = []

    for (const part of toolCalls) {
      const { name, args } = part.functionCall
      console.log(`   🔧 ${name}(${JSON.stringify(args).slice(0, 80)})`)
      let result
      try {
        if (name === 'exec_command') {
          const r = handleExec({ command: args.command, cwd })
          result = `exit:${r.exitCode}\nstdout: ${r.stdout}\n${r.stderr ? 'stderr: ' + r.stderr : ''}`.trim()
        } else if (name === 'read_file') {
          const safe = resolveSafe(cwd, args.path)
          if (safe.error) { result = safe.error } else {
            const r = handleReadFile({ path: safe.resolved })
            result = r.error || (r.content + (r.has_more ? `\n\n${r.note}` : ''))
          }
        } else if (name === 'read_file_chunk') {
          const safe = resolveSafe(cwd, args.path)
          if (safe.error) { result = safe.error } else {
            const r = handleReadFileChunk({ path: safe.resolved, offset: args.offset })
            result = r.error || (r.content + `\n\n${r.note}`)
          }
        } else if (name === 'write_file') {
          const safe = resolveSafe(cwd, args.path)
          if (safe.error) { result = safe.error } else {
            const r = handleWriteFile({ path: safe.resolved, content: args.content })
            result = r.ok ? '✓ 書き込み完了' : r.error
          }
        } else if (name === 'list_dir') {
          const safe = resolveSafe(cwd, args.path)
          if (safe.error) { result = safe.error } else {
            const r = handleListDir({ path: safe.resolved })
            result = r.entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n')
          }
        } else if (name === 'grep_search') {
          result = handleGrepSearch(args, cwd)
        } else if (name === 'glob_files') {
          result = handleGlobFiles(args, cwd)
        } else if (name === 'web_search') {
          result = await handleWebSearch(args)
        }
        console.log(`   ✓ 完了`)
      } catch (e) {
        result = `エラー: ${e.message}`
        console.log(`   ❌ ${e.message}`)
      }
      toolResults.push({ functionResponse: { name, response: { result } } })
    }

    contents.push({ role: 'user', parts: toolResults })
  }
  return '（最大ラウンド数に達しました）'
}

// ─── Quality check ────────────────────────────────────────────────────────────

function isQuestionBack(response) {
  if (!response || response.length < 10) return false
  const questionPatterns = [
    /どれ(をしたい|にしますか|ですか)/,
    /以下のいずれか/,
    /何をしましょうか/,
    /どちらですか/,
    /どういう意図/,
    /具体的に教えて/,
    /確認させてください/,
    /意図を教えてください/,
  ]
  const questionCount = (response.match(/？/g) || []).length
  const hasPattern = questionPatterns.some(p => p.test(response))
  // 質問が3つ以上 OR 質問返しパターンに一致
  return questionCount >= 3 || hasPattern
}

// ─── Command handlers ─────────────────────────────────────────────────────────

const READ_CHUNK_SIZE = 6000  // 1チャンクあたりの文字数

function handleReadFile(payload) {
  const filePath = path.resolve(payload.path)
  if (!fs.existsSync(filePath)) return { error: `File not found: ${payload.path}` }
  const full = fs.readFileSync(filePath, 'utf8')
  const total = full.length
  if (total <= READ_CHUNK_SIZE) {
    return { content: full, path: filePath, total_chars: total, has_more: false }
  }
  // 大きいファイルは分割して返す
  const chunk = full.slice(0, READ_CHUNK_SIZE)
  return {
    content: chunk,
    path: filePath,
    total_chars: total,
    has_more: true,
    next_offset: READ_CHUNK_SIZE,
    note: `⚠️ ファイルが大きいため最初の${READ_CHUNK_SIZE}文字を返しました（全${total}文字）。続きはread_file_chunkで取得してください。`
  }
}

function handleReadFileChunk(payload) {
  const filePath = path.resolve(payload.path)
  if (!fs.existsSync(filePath)) return { error: `File not found: ${payload.path}` }
  const full = fs.readFileSync(filePath, 'utf8')
  const offset = payload.offset || 0
  const total = full.length
  if (offset >= total) return { content: '', has_more: false, note: 'ファイルの末尾に達しました。' }
  const chunk = full.slice(offset, offset + READ_CHUNK_SIZE)
  const nextOffset = offset + READ_CHUNK_SIZE
  return {
    content: chunk,
    path: filePath,
    offset,
    total_chars: total,
    has_more: nextOffset < total,
    next_offset: nextOffset < total ? nextOffset : null,
    note: nextOffset < total
      ? `${offset}〜${nextOffset}文字目 / 全${total}文字。まだ続きがあります。`
      : `${offset}〜${total}文字目 / 全${total}文字。ファイルの末尾です。`
  }
}

function resolveSafe(cwd, inputPath) {
  const resolved = path.resolve(cwd, inputPath)
  const normalizedCwd = path.resolve(cwd)
  if (!resolved.startsWith(normalizedCwd + path.sep) && resolved !== normalizedCwd) {
    return { error: `エラー: 作業ディレクトリ外へのアクセスは禁止されています。\n許可: ${normalizedCwd}\nリクエスト: ${resolved}` }
  }
  return { resolved }
}

function handleWriteFile(payload) {
  const filePath = path.resolve(payload.path)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (payload.mode === 'patch' && fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8')
    if (!content.includes(payload.search)) return { error: 'Search string not found' }
    fs.writeFileSync(filePath, content.replace(payload.search, payload.replace), 'utf8')
  } else {
    fs.writeFileSync(filePath, payload.content || '', 'utf8')
  }
  return { ok: true, path: filePath }
}

function handleExec(payload) {
  try {
    const stdout = execSync(payload.command, { cwd: payload.cwd || process.cwd(), timeout: 300000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || e.message, exitCode: e.status || 1 }
  }
}

function handleFileTree(payload) {
  const root = path.resolve(payload.root || process.cwd())
  const tree = buildTree(root, 0, payload.depth || 5)
  return { root, tree, text: treeToText(tree) }
}

function handleListDir(payload) {
  const dir = path.resolve(payload.path || process.cwd())
  return { path: dir, entries: fs.readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) }
}

// ─── Walk directory iteratively (safe for thousands of files) ─────────────────
function* walkFiles(root) {
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.shift()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue
      if (IGNORE.includes(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        queue.push(full)
      } else {
        yield full
      }
    }
  }
}

// glob pattern → regex変換
function globToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, '/')
  let regexStr = ''
  let i = 0
  while (i < normalized.length) {
    const c = normalized[i]
    if (c === '*' && normalized[i + 1] === '*') {
      regexStr += '.*'
      i += 2
      if (normalized[i] === '/') i++
    } else if (c === '*') {
      regexStr += '[^/]*'
      i++
    } else if (c === '?') {
      regexStr += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(c)) {
      regexStr += '\\' + c
      i++
    } else {
      regexStr += c
      i++
    }
  }
  return new RegExp(regexStr + '$', 'i')
}

function isBinaryFile(filePath) {
  try {
    const buf = Buffer.alloc(512)
    const fd = fs.openSync(filePath, 'r')
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0)
    fs.closeSync(fd)
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true  // nullバイト = バイナリ
    }
    return false
  } catch { return true }
}

function handleGrepSearch(payload, cwd) {
  const { pattern, file_pattern, case_sensitive = false, max_results = 50 } = payload
  const root = path.resolve(cwd)
  const maxRes = Math.min(max_results, 200)

  let searchRegex
  try {
    searchRegex = new RegExp(pattern, case_sensitive ? '' : 'i')
  } catch {
    searchRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), case_sensitive ? '' : 'i')
  }

  let fileRegex = null
  if (file_pattern) {
    fileRegex = globToRegex(file_pattern)
  }

  const results = []
  for (const filePath of walkFiles(root)) {
    if (results.length >= maxRes) break

    // ファイルパターンフィルタ
    if (fileRegex && !fileRegex.test(filePath.replace(/\\/g, '/'))) continue

    // バイナリファイルをスキップ
    if (isBinaryFile(filePath)) continue

    let content
    try { content = fs.readFileSync(filePath, 'utf8') } catch { continue }

    const lines = content.split('\n')
    for (let i = 0; i < lines.length && results.length < maxRes; i++) {
      if (searchRegex.test(lines[i])) {
        const relPath = path.relative(root, filePath).replace(/\\/g, '/')
        results.push({
          file: relPath,
          line: i + 1,
          text: lines[i].trim().slice(0, 200),
        })
      }
    }
  }

  if (results.length === 0) return `「${pattern}」はどのファイルにも見つかりませんでした。`

  const header = `「${pattern}」の検索結果: ${results.length}件${results.length >= maxRes ? `（上限${maxRes}件）` : ''}\n`
  const body = results.map(r => `${r.file}:${r.line}  ${r.text}`).join('\n')
  return header + body
}

function handleGlobFiles(payload, cwd) {
  const { pattern, max_results = 100 } = payload
  const root = path.resolve(cwd)
  const maxRes = Math.min(max_results, 300)
  const fileRegex = globToRegex(pattern)

  const results = []
  for (const filePath of walkFiles(root)) {
    if (results.length >= maxRes) break
    const relPath = filePath.replace(/\\/g, '/')
    const relFromRoot = path.relative(root, filePath).replace(/\\/g, '/')
    if (fileRegex.test(relFromRoot) || fileRegex.test(relPath)) {
      const stat = fs.statSync(filePath)
      results.push({ path: relFromRoot, size: stat.size })
    }
  }

  if (results.length === 0) return `パターン「${pattern}」に一致するファイルは見つかりませんでした。`

  const header = `「${pattern}」に一致するファイル: ${results.length}件${results.length >= maxRes ? `（上限${maxRes}件）` : ''}\n`
  const body = results.map(r => `${r.path}  (${r.size}B)`).join('\n')
  return header + body
}

// ─── 4-Phase execution: 探索→計画→確認→実行 ──────────────────────────────────

const LARGE_TASK_PATTERNS = [
  /作って|作成して|実装して|開発して|構築して|追加して/,
  /ダッシュボード|ページ|画面|機能|コンポーネント|モジュール/,
  /完成|完璧|全部|全て|すべて|まとめて/,
  /アプリ|システム|サービス|サイト/,
  /一から|ゼロから|新しく|リニューアル/,
]

const CONFIRMATION_PATTERNS = [
  /^(はい|yes|ok|OK|オーケー|お願いします|進めて|実行して|やって|どうぞ|続けて|合ってます|その通り|問題ない|大丈夫|いいです|始めて|スタート|go|GO)[\s。！]*$/i,
]

function isLargeTask(message) {
  if (message.length < 10) return false
  return LARGE_TASK_PATTERNS.filter(p => p.test(message)).length >= 2
}

function isConfirmation(message) {
  return CONFIRMATION_PATTERNS.some(p => p.test(message.trim()))
}

// 読み取り専用ツール（探索・計画フェーズで使用）
const READONLY_TOOLS = ['read_file', 'read_file_chunk', 'list_dir', 'glob_files', 'grep_search', 'web_search']

async function runReadonlyTools(toolUses, cwd) {
  return Promise.all(toolUses.map(async block => {
    const { name, input, id } = block
    let result = ''
    try {
      if (name === 'read_file') { const safe = resolveSafe(cwd, input.path); if (safe.error) { result = safe.error } else { const r = handleReadFile({ path: safe.resolved }); result = r.error || (r.content + (r.has_more ? `\n\n${r.note}` : '')) } }
      else if (name === 'read_file_chunk') { const safe = resolveSafe(cwd, input.path); if (safe.error) { result = safe.error } else { const r = handleReadFileChunk({ path: safe.resolved, offset: input.offset }); result = r.error || r.content } }
      else if (name === 'list_dir') { const safe = resolveSafe(cwd, input.path); if (safe.error) { result = safe.error } else { const r = handleListDir({ path: safe.resolved }); result = r.entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n') } }
      else if (name === 'glob_files') { result = handleGlobFiles(input, cwd) }
      else if (name === 'grep_search') { result = handleGrepSearch(input, cwd) }
      else if (name === 'web_search') { result = await handleWebSearch(input) }
    } catch (e) { result = `エラー: ${e.message}` }
    return { type: 'tool_result', tool_use_id: id, content: String(result) }
  }))
}

async function callReadonlyLoop(anthropicKey, systemPrompt, userMessage, cwd, cfg, commandId, logPrefix, maxRounds) {
  const { default: fetch } = await import('node-fetch')
  const tools = CLAUDE_TOOLS.filter(t => READONLY_TOOLS.includes(t.name))
  const messages = [{ role: 'user', content: userMessage }]
  let streamLog = logPrefix
  await postStream(cfg, commandId, streamLog)
  let finalText = ''

  for (let round = 0; round < maxRounds; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODELS.sonnet, max_tokens: 8192, system: systemPrompt, tools, messages }),
    })
    const data = await res.json()
    if (data.error) throw new Error(`Claude error: ${data.error.message}`)

    const toolUses = data.content?.filter(b => b.type === 'tool_use') || []
    const textBlocks = data.content?.filter(b => b.type === 'text') || []
    if (textBlocks.length > 0) finalText = textBlocks.map(b => b.text).join('')
    if (data.stop_reason === 'end_turn' || toolUses.length === 0) break

    messages.push({ role: 'assistant', content: data.content })
    streamLog += `\n🔧 [${round + 1}] ${toolUses.map(b => b.name).join(', ')}`
    await postStream(cfg, commandId, streamLog)
    const results = await runReadonlyTools(toolUses, cwd)
    streamLog += ' ✓'
    await postStream(cfg, commandId, streamLog)
    messages.push({ role: 'user', content: results })
  }
  return finalText
}

// Phase 1: 探索
async function runExploration(anthropicKey, baseSystemPrompt, message, cwd, cfg, commandId) {
  const prompt = `${baseSystemPrompt}

【探索フェーズ】
あなたの仕事はプロジェクトを徹底的に調査することだけ。コードを書いてはいけない。

以下を調査してまとめてください:
1. glob_filesで全ファイル構成を把握（**/*.ts, **/*.tsx, **/*.js）
2. package.jsonで技術スタックを確認
3. 主要ファイル（ページ、コンポーネント、API）を読む
4. 既存の実装状況を把握

出力形式（必ずこの形式で）:
---
## プロジェクト探索結果

### 技術スタック
[フレームワーク・ライブラリ一覧]

### ファイル構成
[主要ディレクトリとファイル]

### 既存の実装状況
[何が既にあって、何がないか]

### ユーザーのタスク「${message}」に関連する既存コード
[関連するファイルと内容の概要]
---`

  return callReadonlyLoop(anthropicKey, prompt, message, cwd, cfg, commandId, '🔍 Phase 1: プロジェクトを探索中...', 8)
}

// Phase 2: 計画
async function runPlanning(anthropicKey, baseSystemPrompt, message, explorationResult, cwd, cfg, commandId) {
  const prompt = `${baseSystemPrompt}

【計画フェーズ】
以下の探索結果をもとに、実装計画を作成してください。ツールは必要なときだけ使う。コードを書いてはいけない。

## 探索結果
${explorationResult}

出力形式（必ずこの形式で）:
---
## 実装計画: [タスク名]

### 実装ステップ
1. [具体的な作業内容] → \`対象ファイルパス\`
2. [具体的な作業内容] → \`対象ファイルパス\`
（以降続く）

### 注意点
[依存関係・互換性・リスク]

### 推定ステップ数
[N ステップ]
---

計画の最後に必ず「この計画で実装を進めてよいですか？」と聞いてください。`

  return callReadonlyLoop(anthropicKey, prompt, message, cwd, cfg, commandId, '📋 Phase 2: 実装計画を作成中...', 5)
}

async function handleWebSearch(payload) {
  const { query, max_results = 5 } = payload
  const { default: fetch } = await import('node-fetch')
  const maxRes = Math.min(max_results, 10)

  try {
    // DuckDuckGo lite page scraping
    const url = `https://lite.duckduckgo.com/lite?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9',
      },
      timeout: 15000,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()

    const results = []
    // DuckDuckGo lite uses single quotes for class, double quotes for href
    // href contains redirect: //duckduckgo.com/l/?uddg=ENCODED_REAL_URL
    const linkRe = /href="([^"]+)"[^>]*class='result-link'>([^<]+)<\/a>/gi
    const snippetRe = /class='result-snippet'[^>]*>([\s\S]*?)<\/td>/gi
    const links = []
    let m
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1]
      // Extract real URL from uddg param
      const uddgMatch = href.match(/[?&]uddg=([^&]+)/)
      const realUrl = uddgMatch ? decodeURIComponent(uddgMatch[1]) : href
      links.push({ url: realUrl, title: m[2].trim() })
    }
    const snippets = []
    while ((m = snippetRe.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
      snippets.push(text)
    }

    for (let i = 0; i < Math.min(links.length, maxRes); i++) {
      results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' })
    }

    // Fallback: DuckDuckGo Instant Answer API
    if (results.length === 0) {
      const apiRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { timeout: 10000 })
      const data = await apiRes.json()
      if (data.AbstractText) return `「${query}」\n\n${data.AbstractText}\n出典: ${data.AbstractURL}`
      if (data.RelatedTopics?.length > 0) {
        const topics = data.RelatedTopics.slice(0, maxRes).map(t => t.Text || '').filter(Boolean).join('\n')
        return `「${query}」\n\n${topics}`
      }
      return `「${query}」の検索結果が見つかりませんでした。`
    }

    const header = `「${query}」の検索結果: ${results.length}件\n\n`
    const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
    return header + body
  } catch (e) {
    return `検索エラー: ${e.message}`
  }
}

async function handleChat(payload, cfg, commandId) {
  if (!cfg.geminiKey && !cfg.anthropicKey) return { error: 'APIキーが設定されていません。' }

  const cwd = payload.cwd || process.cwd()
  const { message, history = [] } = payload

  console.log(`   📂 作業ディレクトリ: ${cwd}`)

  // ─── Context persistence (feature 3) ──────────────────────────────────────
  const savedCtx = loadProjectContext(cwd)

  const topLevel = handleListDir({ path: cwd })
  const topLevelText = topLevel.entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n')

  const systemPrompt = `あなたはローカルPCに直接接続されたAIエンジニアアシスタントです。
作業ディレクトリ: ${cwd}
OS: Windows (cmd.exe)

【トップレベルのファイル/フォルダ】
${topLevelText}
${savedCtx ? `
【前回のコンテキスト — これを参照して答えること】
${savedCtx.summary}
※「前回」「覚えてる？」などの質問は、このコンテキストだけで答える。ファイルを読みに行かないこと。
` : ''}
【意図の推測ルール — 最重要】
ユーザーの言葉が曖昧なときは、文脈から意図を推測して行動する。質問返しは禁止。

よくある曖昧な表現と正しい解釈：
- 「確認したい」「見たい」「動かしたい」→ 開発サーバー起動（pnpm dev / npm run dev）
- 「デプロイしたい」「本番で動かしたい」→ ビルド（pnpm build）してから起動
- 「直して」「治して」→ エラーを特定して修正
- 「調べて」「確認して」→ ファイルを読む・検索する
- 「追加して」「作って」→ ファイルを作成・編集する
- 「消して」「削除して」→ 該当ファイル・コードを削除
- 「テストして」→ テストコマンドを実行
- 「最初から」「リセット」→ git status確認してから判断

【スコープ制限 — 絶対厳守】
- read_file・write_file・list_dirのパスは必ず ${cwd} 以下のみ。絶対パスを使う場合も ${cwd} の子ディレクトリのみ許可。
- 他のプロジェクト（${cwd} 以外のディレクトリ）のファイルを読んだり書いたりしてはいけない。
- grep_search・glob_files は自動的に ${cwd} 内のみを検索する。

【絶対ルール — 違反禁止】
- ユーザーが「〜して」「〜を実行して」「〜を削除して」と言ったら、即座にツールを使って実行する。説明だけして終わるな。
- コマンド実行の指示（build, install, test, git など）は必ずexec_commandで実行する。
- 「どういう意図ですか？」「以下のいずれかですか？」などの質問返しは禁止。
- 必要な情報はgrep_search・glob_files・list_dir・read_fileツールで自分で取得する。ユーザーに聞くな。
- Windowsパスに括弧()やスペースがある場合はダブルクォートで囲む。
- テキストだけで「実行しました」と報告せず、必ずツールで実行してから報告する。

【情報がないときの行動ルール — 最重要】
- 「わからない」「情報がない」と思ったら、まずgrep_searchやglob_filesで探す。絶対に諦めるな。
- 料金・機能・仕様・設定など、プロジェクトに関する質問はファイルを探してから答える。
- 自分で情報を作るな（hallucination禁止）。ファイルに書いてあることだけを答える。
- 探しても見つからなかった場合のみ「ファイルには見当たらなかった」と正直に言う。

【回答のトーンと長さ】
- 短く・カジュアルに・人間らしく答える。
- 表（markdown table）を多用しない。箇条書き・見出しも最小限にする。
- ユーザーがカジュアルに質問してきたら、カジュアルに一言〜数行で答える。
- 長文の分析レポートを求められていないのに書くな。

【ファイル読み込みルール】
- read_fileでhas_more=trueが返ったら、必ずread_file_chunkで続きを読んでから回答する。
- 大きいファイルは全部読んでから判断する。途中で諦めない。

【エラー自動修復ルール】
- コマンドがエラー(exit!=0)を返したら、原因を分析して修正コマンドを実行し、再試行する。
- "not found"はPATHの問題 → フルパスで実行するか、npmのグローバルパスを確認する。
- ENOENT/ENOSPCはパス・権限の問題 → ディレクトリ確認してから実行する。
- 3回修正しても失敗したらユーザーに状況を報告する。`

  const model = payload.model || 'haiku'
  let response

  if (cfg.anthropicKey) {
    const phase = loadPhase(cwd)

    // ─── Phase 4: 確認済み → 実行 ────────────────────────────────────────────
    if (phase?.current === 'awaiting_confirmation' && isConfirmation(message)) {
      console.log(`   🚀 Phase 4: 実行フェーズ開始`)
      savePhase(cwd, { current: 'execution', workJournal: [] })

      const journal = getJournal(cwd)
      const journalText = journal.length > 0 ? `\n\n【作業ジャーナル】\n${journal.join('\n')}` : ''

      const execSystemPrompt = `${systemPrompt}

【実行フェーズ — 計画通りに今すぐ実装する】
ユーザーが計画を承認しました。上から順番に全ステップを実行してください。
途中で止まらず、全ステップ完了まで続ける。

## 探索結果（参考）
${phase.explorationResult || ''}

## 実装計画（これを実行する）
${phase.plan || ''}
${journalText}`

      await postStream(cfg, commandId, '🚀 Phase 4: 実行開始...')
      response = await callClaudeWithTools(
        cfg.anthropicKey, execSystemPrompt, [], phase.originalMessage, 'sonnet', cwd, cfg, commandId,
        (roundSummary) => appendJournal(cwd, roundSummary)
      )
      clearPhase(cwd)

    // ─── 実行中の継続（途中で止まった場合） ──────────────────────────────────
    } else if (phase?.current === 'execution') {
      console.log(`   🔄 実行継続中...`)
      const journal = getJournal(cwd)
      const journalText = journal.slice(-30).join('\n')

      const continuePrompt = `${systemPrompt}

【実行継続フェーズ】
## これまでの作業ジャーナル
${journalText}

## 残りの計画
${phase.plan || ''}

前回の続きから再開してください。`

      response = await callClaudeWithTools(
        cfg.anthropicKey, continuePrompt, history, message, 'sonnet', cwd, cfg, commandId,
        (roundSummary) => appendJournal(cwd, roundSummary)
      )

    // ─── Phase 1→2: 大きなタスク → 探索→計画 ─────────────────────────────────
    } else if (isLargeTask(message) && !phase) {
      console.log(`   🔍 大きなタスク検出 → Phase 1: 探索開始`)
      savePhase(cwd, { current: 'exploration', originalMessage: message })

      // Phase 1: 探索
      const explorationResult = await runExploration(cfg.anthropicKey, systemPrompt, message, cwd, cfg, commandId)
      savePhase(cwd, { current: 'planning', explorationResult })

      // Phase 2: 計画
      const plan = await runPlanning(cfg.anthropicKey, systemPrompt, message, explorationResult, cwd, cfg, commandId)
      savePhase(cwd, { current: 'awaiting_confirmation', plan })
      response = plan

    // ─── 通常の実行 ──────────────────────────────────────────────────────────
    } else {
      // 実行中以外でフェーズが残っていたらリセット
      if (phase && !isConfirmation(message)) clearPhase(cwd)

      console.log(`   🤖 Claude ${model} 開始...`)

      // 作業ジャーナルをシステムプロンプトに注入
      const journal = getJournal(cwd)
      const journalInjection = journal.length > 0
        ? `\n\n【直近の作業ジャーナル】\n${journal.slice(-20).join('\n')}`
        : ''

      response = await callClaudeWithTools(
        cfg.anthropicKey, systemPrompt + journalInjection, history, message, model, cwd, cfg, commandId,
        (roundSummary) => appendJournal(cwd, roundSummary)
      )

      // Haikuが質問返しをした場合、Sonnetに自動切り替え
      if (model === 'haiku' && isQuestionBack(response)) {
        console.log(`   🔄 Haikuが質問返し → Sonnetに自動切り替え`)
        await postStream(cfg, commandId, '⚡ Haikuでは対応困難 → 🧠 Sonnetに切り替えています...')
        const sonnetResponse = await callClaudeWithTools(
          cfg.anthropicKey, systemPrompt + journalInjection, history, message, 'sonnet', cwd, cfg, commandId,
          (roundSummary) => appendJournal(cwd, roundSummary)
        )
        response = `> ⚡ Haikuでは回答困難だったため、自動的に🧠 Sonnetに切り替えました。\n\n${sonnetResponse}`
      }
    }
  } else if (cfg.geminiKey) {
    console.log(`   🤖 Gemini Function Calling 開始...`)
    response = await callGeminiWithTools(cfg.geminiKey, systemPrompt, history, message, cwd)
  } else {
    return { error: 'APIキーが設定されていません' }
  }

  // ─── Save project context after each chat ─────────────────────────────────
  try {
    const contextSummary = `最後の作業: ${new Date().toLocaleString('ja-JP')}
ユーザーの質問: ${message.slice(0, 200)}
AIの回答要約: ${response.slice(0, 500)}`
    saveProjectContext(cwd, contextSummary)
  } catch { /* ignore */ }

  console.log(`   ✓ 回答生成完了 (${response.length}文字)`)
  return { response }
}

async function dispatch(cmd, cfg) {
  const cwd = cmd.payload?.cwd || process.cwd()
  switch (cmd.type) {
    case 'read_file':   return handleReadFile(cmd.payload)
    case 'write_file':  return handleWriteFile(cmd.payload)
    case 'exec':        return handleExec(cmd.payload)
    case 'file_tree':   return handleFileTree(cmd.payload)
    case 'list_dir':    return handleListDir(cmd.payload)
    case 'grep_search': return { result: handleGrepSearch(cmd.payload, cwd) }
    case 'glob_files':  return { result: handleGlobFiles(cmd.payload, cwd) }
    case 'web_search':  return { result: await handleWebSearch(cmd.payload) }
    case 'chat':        return await handleChat(cmd.payload, cfg, cmd.id)
    default:            return { error: `Unknown command: ${cmd.type}` }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 2000
const PING_INTERVAL = 30000

async function mainLoop(cfg) {
  let lastPing = 0
  console.log(`\n✅ MyMemGuard Agent 起動中`)
  console.log(`   接続先: ${cfg.url}`)
  console.log(`   作業ディレクトリ: ${process.cwd()}`)
  console.log(`   AIエンジン: ${cfg.anthropicKey ? '✓ Claude (Haiku/Sonnet)' : cfg.geminiKey ? '✓ Gemini' : '✗ 未設定'}`)
  console.log(`   Ctrl+C で停止\n`)

  while (true) {
    try {
      if (Date.now() - lastPing > PING_INTERVAL) {
        await apiFetch(`${cfg.url}/api/agent/ping`, 'POST', { cwd: process.cwd() }, cfg.token)
        lastPing = Date.now()
      }

      const { commands } = await apiFetch(`${cfg.url}/api/agent/poll`, 'GET', null, cfg.token)

      for (const cmd of commands || []) {
        console.log(`⚡ [${cmd.type}] ${JSON.stringify(cmd.payload).slice(0, 100)}`)
        let result, error
        try {
          result = await dispatch(cmd, cfg)
          if (result?.error) { error = result.error; result = null }
        } catch (e) {
          error = e.message
        }
        await apiFetch(`${cfg.url}/api/agent/result`, 'POST', {
          command_id: cmd.id,
          status: error ? 'error' : 'done',
          result,
          error,
        }, cfg.token)
        console.log(`   ${error ? '❌ ' + error : '✓ 完了'}`)
      }
    } catch (e) {
      console.error(`接続エラー: ${e.message} — 再試行中...`)
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
}

// ─── Setup & Start ────────────────────────────────────────────────────────────

async function main() {
  let cfg = loadConfig()

  if (!cfg) {
    console.log('🧠 MyMemGuard Agent セットアップ\n')
    const url = await ask('MyMemGuardのURL (例: https://mymemguard.vercel.app): ')
    const token = await ask('APIトークン (MyMemGuardの設定画面でコピー): ')
    const anthropicKey = await ask('Anthropic APIキー (sk-ant-... / なければEnterでスキップ): ')
    const geminiKey = await ask('Gemini APIキー (なければEnterでスキップ): ')
    cfg = { url: url.replace(/\/$/, ''), token, anthropicKey: anthropicKey || null, geminiKey: geminiKey || null }

    try {
      const res = await apiFetch(`${cfg.url}/api/agent/ping`, 'POST', { cwd: process.cwd() }, cfg.token)
      if (res.ok) {
        saveConfig(cfg)
        console.log('\n✅ 接続成功！設定を保存しました\n')
      } else {
        console.error('❌ 接続失敗。URLとトークンを確認してください')
        process.exit(1)
      }
    } catch (e) {
      console.error(`❌ 接続エラー: ${e.message}`)
      process.exit(1)
    }
  }

  mainLoop(cfg)
}

main()
