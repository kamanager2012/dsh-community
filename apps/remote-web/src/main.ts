import { base64Encode, hexToBytes, sha256Hex } from './crypto/bytes.ts'
import { RemoteWebKeyStore, type ClientDeviceIdentity } from './client/keystore.ts'
import {
  consumePairFragmentFromLocation,
  parsePairingInput,
  sanitizeDiagnosticMessage,
} from './client/pairing.ts'
import {
  RemoteRpcError,
  RemoteWebClient,
  type RemoteClientStatusEvent,
} from './client/remote-client.ts'
import { SessionTimelineState } from './client/timeline.ts'
import type {
  AgentEngineId,
  EngineDescriptor,
  ModelCatalogResult,
  ModelSelectionParams,
  PairingBootstrapDescriptor,
  PendingApprovalSnapshot,
  PendingQuestionSnapshot,
  PromptImageAttachment,
  PromptImageMediaType,
  RemoteCommandDescriptor,
  SessionRef,
  SessionSearchHit,
  TrustedHostProfile,
  WorkspaceGitDiffResult,
  WorkspaceGitStatusResult,
} from './client/types.ts'
import { renderMarkdown, renderUnifiedDiff } from './ui/markdown.ts'
import {
  decodeQrFromImageFile,
  isBarcodeDetectorSupported,
  startCameraQrScanner,
  type CameraQrScannerSession,
} from './ui/qr-scanner.ts'

interface AppState {
  identity: ClientDeviceIdentity | undefined
  savedHosts: TrustedHostProfile[]
  statusEvt: RemoteClientStatusEvent
  pairingInput: string
  pairingError: string | undefined
  parsedPreview: PairingBootstrapDescriptor | undefined
  engines: EngineDescriptor[]
  sessions: SessionRef[]
  activeSessionId: string | undefined
  timelines: Map<string, SessionTimelineState>
  modelsBySession: Map<string, ModelCatalogResult>
  commandsBySession: Map<string, RemoteCommandDescriptor[]>
  gitStatus: WorkspaceGitStatusResult | undefined
  gitDiff: WorkspaceGitDiffResult | undefined
  gitStaged: boolean
  gitSelectedPath: string | undefined
  gitError: string | undefined
  gitLoading: boolean
  activeTab: 'chat' | 'diff'
  mobileDrawerOpen: boolean
  newSessionOpen: boolean
  securityModalOpen: boolean
  qrModalOpen: boolean
  modelModalOpen: boolean
  searchQuery: string
  searchHits: SessionSearchHit[] | undefined
  draftBySession: Map<string, string>
  promptMode: 'followup' | 'steer'
  pendingAttachments: PromptImageAttachment[]
  expandedDetailIds: Set<string>
  questionDrafts: Map<string, Map<number, string[]>>
  toastMessage: string | undefined
  submittingPrompt: boolean
}

const keyStore = new RemoteWebKeyStore()
const client = new RemoteWebClient(keyStore)

const state: AppState = {
  identity: undefined,
  savedHosts: [],
  statusEvt: { status: 'disconnected' },
  pairingInput: '',
  pairingError: undefined,
  parsedPreview: undefined,
  engines: [],
  sessions: [],
  activeSessionId: undefined,
  timelines: new Map(),
  modelsBySession: new Map(),
  commandsBySession: new Map(),
  gitStatus: undefined,
  gitDiff: undefined,
  gitStaged: false,
  gitSelectedPath: undefined,
  gitError: undefined,
  gitLoading: false,
  activeTab: 'chat',
  mobileDrawerOpen: false,
  newSessionOpen: false,
  securityModalOpen: false,
  qrModalOpen: false,
  modelModalOpen: false,
  searchQuery: '',
  searchHits: undefined,
  draftBySession: new Map(),
  promptMode: 'followup',
  pendingAttachments: [],
  expandedDetailIds: new Set(),
  questionDrafts: new Map(),
  toastMessage: undefined,
  submittingPrompt: false,
}

let activeCameraScanner: CameraQrScannerSession | undefined = undefined
let timelineRefreshTimer: ReturnType<typeof setTimeout> | undefined = undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined = undefined

function shortFp(fp: string | undefined): string {
  if (!fp) return 'unknown'
  return `${fp.slice(0, 6)}:${fp.slice(6, 12)}`
}

function showToast(msg: string): void {
  state.toastMessage = sanitizeDiagnosticMessage(msg)
  if (toastTimer) clearTimeout(toastTimer)
  renderBannerAndToast()
  toastTimer = setTimeout(() => {
    state.toastMessage = undefined
    renderBannerAndToast()
  }, 4_500)
}

function getOrCreateTimeline(sessionId: string): SessionTimelineState {
  let tl = state.timelines.get(sessionId)
  if (!tl) {
    tl = new SessionTimelineState(sessionId)
    state.timelines.set(sessionId, tl)
  }
  return tl
}

function getActiveSession(): SessionRef | undefined {
  if (!state.activeSessionId) return undefined
  return state.sessions.find((s) => s.id === state.activeSessionId)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function engineBadgeLabel(engine: AgentEngineId | undefined): string {
  switch ((engine ?? 'dsh').toLowerCase()) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'OpenCode'
    case 'acp':
      return 'ACP'
    default:
      return 'DSH'
  }
}

function transportBadgeLabel(): { text: string; cls: string } {
  switch (state.statusEvt.status) {
    case 'active':
      switch (state.statusEvt.transport) {
        case 'lan':
          return { text: 'LAN E2EE', cls: 'pill-ok' }
        case 'webrtc':
          return { text: 'WebRTC P2P', cls: 'pill-ok' }
        case 'relay':
          return { text: 'Relay E2EE', cls: 'pill-warn' }
        default:
          return { text: 'Connected', cls: 'pill-ok' }
      }
    case 'connecting':
    case 'handshaking':
      return { text: 'Handshaking...', cls: 'pill-info' }
    case 'pairing':
      return { text: 'Awaiting Approval', cls: 'pill-warn' }
    case 'reconnecting':
      return { text: 'Reconnecting...', cls: 'pill-warn' }
    case 'revoked':
      return { text: 'Revoked', cls: 'pill-err' }
    case 'epoch_mismatch':
      return { text: 'Epoch Reset', cls: 'pill-err' }
    case 'error':
      return { text: 'Error', cls: 'pill-err' }
    default:
      return { text: 'Offline', cls: 'pill-muted' }
  }
}

async function refreshWorkspaceData(): Promise<void> {
  if (client.getStatus() !== 'active') return
  const [enginesRes, sessionsRes] = await Promise.allSettled([
    client.listEngines(),
    client.listSessions(),
  ])
  if (enginesRes.status === 'fulfilled') {
    state.engines = enginesRes.value
  }
  if (sessionsRes.status === 'fulfilled') {
    state.sessions = sessionsRes.value
    for (const s of state.sessions) {
      const tl = getOrCreateTimeline(s.id)
      if (s.title) tl.title = s.title
      if (s.status) tl.status = s.status
      if (s.model) tl.model = s.model
    }
    if (!state.activeSessionId && state.sessions.length > 0) {
      state.activeSessionId = state.sessions[0]!.id
    }
  }
  state.savedHosts = await keyStore.listTrustedHosts()
  if (state.activeSessionId) {
    await attachActiveSession(state.activeSessionId)
  } else {
    renderApp()
  }
}

async function attachActiveSession(sessionId: string): Promise<void> {
  state.activeSessionId = sessionId
  const tl = getOrCreateTimeline(sessionId)
  tl.markRead()
  renderApp()

  if (client.getStatus() !== 'active') return
  try {
    const afterSeq = tl.highestSeq > 0 ? tl.highestSeq : undefined
    const attached = await client.attachSession(sessionId, afterSeq)
    tl.applyLiveStateSnapshot(attached.liveState)
    if (attached.kind === 'events') {
      for (const ev of attached.events) {
        tl.applyEvent(ev, { markUnread: false })
      }
      if (tl.items.length === 0 && (attached.liveState?.hasMoreHistory || afterSeq === undefined)) {
        const hist = await client.getSessionHistory(sessionId, { limit: 80 })
        for (const ev of hist.events) {
          tl.applyEvent(ev, { markUnread: false })
        }
        tl.hasMoreHistory = hist.hasMore
        tl.oldestSeq = hist.oldestSeq
      }
    } else {
      // Window reset: pull durable history around latest seq
      const hist = await client.getSessionHistory(sessionId, { limit: 80 })
      tl.prependHistory(hist.events, hist.hasMore, hist.oldestSeq)
    }

    const [modelsRes, cmdsRes] = await Promise.allSettled([
      client.listModels(sessionId),
      client.listCommands(sessionId),
    ])
    if (modelsRes.status === 'fulfilled') {
      state.modelsBySession.set(sessionId, modelsRes.value)
    }
    if (cmdsRes.status === 'fulfilled') {
      state.commandsBySession.set(sessionId, cmdsRes.value)
    }

    if (state.activeTab === 'diff') {
      await loadGitReview(sessionId)
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err))
  }
  renderApp()
  scrollChatToBottom()
}

async function loadOlderHistory(): Promise<void> {
  if (!state.activeSessionId || client.getStatus() !== 'active') return
  const tl = getOrCreateTimeline(state.activeSessionId)
  if (!tl.oldestSeq) return
  try {
    const hist = await client.getSessionHistory(state.activeSessionId, {
      beforeSeq: tl.oldestSeq,
      limit: 60,
    })
    tl.prependHistory(hist.events, hist.hasMore, hist.oldestSeq)
    renderTimelineArea()
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err))
  }
}

async function loadGitReview(sessionId: string): Promise<void> {
  if (client.getStatus() !== 'active') return
  state.gitLoading = true
  state.gitError = undefined
  renderMainBody()
  try {
    const [status, diff] = await Promise.all([
      client.getWorkspaceGitStatus(sessionId),
      client.getWorkspaceGitDiff(sessionId, {
        staged: state.gitStaged,
        ...(state.gitSelectedPath ? { path: state.gitSelectedPath } : {}),
        maxBytes: 256_000,
      }),
    ])
    if (state.activeSessionId === sessionId) {
      state.gitStatus = status
      state.gitDiff = diff
    }
  } catch (err) {
    state.gitError = err instanceof Error ? err.message : String(err)
  } finally {
    state.gitLoading = false
    renderMainBody()
  }
}

async function handleConnectPairing(rawInput: string): Promise<void> {
  state.pairingError = undefined
  try {
    const descriptor = await parsePairingInput(rawInput)
    state.parsedPreview = descriptor
    renderApp()
    await client.connectWithPairing(descriptor, {
      displayName: buildDeviceDisplayName(),
    })
    state.pairingInput = ''
    state.parsedPreview = undefined
    await refreshWorkspaceData()
  } catch (err) {
    state.pairingError = sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err))
    renderApp()
  }
}

async function handleConnectSavedHost(host: TrustedHostProfile, allowEpochReset = false): Promise<void> {
  state.pairingError = undefined
  try {
    await client.connectToProfile(host, { allowEpochReset })
    await refreshWorkspaceData()
  } catch (err) {
    state.pairingError = sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err))
    renderApp()
  }
}

function buildDeviceDisplayName(): string {
  if (typeof navigator === 'undefined') return 'Web Browser'
  const ua = navigator.userAgent
  if (/iPhone/i.test(ua)) return 'iPhone Safari'
  if (/iPad/i.test(ua)) return 'iPad Safari'
  if (/Android/i.test(ua)) return 'Android Browser'
  if (/Mac/i.test(ua)) return 'Mac Browser'
  return 'Web Browser'
}

async function handleSubmitPrompt(): Promise<void> {
  const sid = state.activeSessionId
  if (!sid || state.submittingPrompt) return
  const draft = (state.draftBySession.get(sid) ?? '').trim()
  const attachments = [...state.pendingAttachments]
  if (!draft && attachments.length === 0) return

  if (draft === '/diff') {
    state.draftBySession.set(sid, '')
    state.activeTab = 'diff'
    await loadGitReview(sid)
    renderApp()
    return
  }

  state.submittingPrompt = true
  const tl = getOrCreateTimeline(sid)
  tl.addOptimisticUserPrompt(
    draft,
    attachments.map((a) => a.name ?? 'image'),
  )
  state.draftBySession.set(sid, '')
  state.pendingAttachments = []
  renderTimelineArea()
  renderComposer()
  scrollChatToBottom()

  try {
    await client.submitPrompt(sid, draft || '[image]', {
      mode: tl.status === 'running' ? state.promptMode : 'followup',
      attachments,
    })
  } catch (err) {
    showToast(`Send failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    state.submittingPrompt = false
    renderComposer()
  }
}

async function handleImagePick(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return
  const allowed: Record<string, PromptImageMediaType> = {
    'image/jpeg': 'image/jpeg',
    'image/png': 'image/png',
    'image/webp': 'image/webp',
    'image/gif': 'image/gif',
  }
  for (const file of Array.from(files)) {
    const mediaType = allowed[file.type]
    if (!mediaType) {
      showToast(`Unsupported image type: ${file.type || file.name}`)
      continue
    }
    if (file.size > 3_500_000) {
      showToast(`Image "${file.name}" exceeds 3.5 MB browser limit`)
      continue
    }
    const buf = new Uint8Array(await file.arrayBuffer())
    state.pendingAttachments = [
      ...state.pendingAttachments,
      {
        type: 'image',
        mediaType,
        dataBase64: base64Encode(buf),
        name: file.name,
      },
    ]
  }
  renderComposer()
}

function scrollChatToBottom(): void {
  const scroller = document.getElementById('chat-scroll')
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight
  }
}

function scheduleTimelineRender(): void {
  if (timelineRefreshTimer) return
  timelineRefreshTimer = setTimeout(() => {
    timelineRefreshTimer = undefined
    const scroller = document.getElementById('chat-scroll')
    const wasNearBottom = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
      : true
    renderTimelineArea()
    renderPendingActionsTray()
    renderSidebarBodyOnly()
    if (wasNearBottom) {
      scrollChatToBottom()
    }
  }, 50)
}

function renderTopHeader(container: HTMLElement): void {
  container.replaceChildren()
  const activeSession = getActiveSession()
  const tl = activeSession ? state.timelines.get(activeSession.id) : undefined
  const pill = transportBadgeLabel()

  const left = el('div', 'topbar-left')
  const menuBtn = el('button', 'btn-ghost icon-btn mobile-only', '☰')
  menuBtn.type = 'button'
  menuBtn.title = 'Toggle Sessions Drawer'
  menuBtn.addEventListener('click', () => {
    state.mobileDrawerOpen = !state.mobileDrawerOpen
    renderApp()
  })

  const brand = el('div', 'brand-wrap')
  const title = el(
    'div',
    'topbar-title',
    activeSession ? tl?.title || activeSession.title || activeSession.id : 'DSH Remote E2EE',
  )
  const sub = el('div', 'topbar-sub')
  if (activeSession) {
    sub.appendChild(el('span', 'badge engine-badge', engineBadgeLabel(activeSession.engine)))
    const model = tl?.model ?? activeSession.model
    if (model) {
      const modelBtn = el(
        'button',
        'badge model-badge clickable',
        `${model.model}${model.reasoningEffort ? ` (${model.reasoningEffort})` : ''}`,
      )
      modelBtn.type = 'button'
      modelBtn.addEventListener('click', () => {
        state.modelModalOpen = true
        renderApp()
      })
      sub.appendChild(modelBtn)
    }
    if (activeSession.workspace?.branch) {
      sub.appendChild(el('span', 'badge branch-badge', `git:${activeSession.workspace.branch}`))
    }
  } else if (state.statusEvt.host) {
    sub.textContent = `${state.statusEvt.host.label} • Host FP ${shortFp(state.statusEvt.host.hostFingerprint)}`
  } else {
    sub.textContent = 'Noise_IK_25519_ChaChaPoly_BLAKE2b'
  }
  brand.append(title, sub)
  left.append(menuBtn, brand)

  const right = el('div', 'topbar-right')
  right.appendChild(el('span', `status-pill ${pill.cls}`, pill.text))
  const secBtn = el('button', 'btn-ghost btn-sm', 'Keys')
  secBtn.type = 'button'
  secBtn.addEventListener('click', () => {
    state.securityModalOpen = true
    renderApp()
  })
  right.appendChild(secBtn)

  container.append(left, right)
}

function renderBannerAndToast(): void {
  const bannerSlot = document.getElementById('banner-slot')
  if (bannerSlot) {
    bannerSlot.replaceChildren()
    const st = state.statusEvt
    if (st.status === 'epoch_mismatch' && st.host) {
      const box = el('div', 'alert-banner err')
      box.appendChild(
        el(
          'span',
          undefined,
          st.detail ?? 'Host epoch restarted. Confirm ONLY if you intentionally restarted the host.',
        ),
      )
      const acceptBtn = el('button', 'btn-danger btn-sm', 'Accept New Epoch & Reconnect')
      acceptBtn.type = 'button'
      const host = st.host
      acceptBtn.addEventListener('click', () => {
        void handleConnectSavedHost(host, true)
      })
      box.appendChild(acceptBtn)
      bannerSlot.appendChild(box)
    } else if (st.status === 'revoked') {
      const box = el('div', 'alert-banner err')
      box.textContent = `Revoked by host: ${st.detail ?? 'Re-pair required with a new token.'}`
      bannerSlot.appendChild(box)
    } else if (st.status === 'pairing' && st.pairingCandidate) {
      const box = el('div', 'alert-banner warn')
      box.textContent = `Pending Host Approval — Device FP ${shortFp(st.pairingCandidate.clientFingerprint)} (Candidate ${st.pairingCandidate.candidateId.slice(0, 8)}). Click Approve on DSH Desktop/CLI.`
      bannerSlot.appendChild(box)
    } else if (st.status === 'reconnecting') {
      const box = el('div', 'alert-banner info')
      box.textContent = st.detail ?? 'Connection interrupted — reconnecting E2EE session...'
      bannerSlot.appendChild(box)
    }
  }

  const toastSlot = document.getElementById('toast-slot')
  if (toastSlot) {
    toastSlot.replaceChildren()
    if (state.toastMessage) {
      toastSlot.appendChild(el('div', 'toast-pill', state.toastMessage))
    }
  }
}

function renderSidebarBodyOnly(): void {
  const body = document.getElementById('sidebar-sessions')
  if (!body) return
  body.replaceChildren()

  if (state.searchHits) {
    const head = el('div', 'group-title', `Search Results (${state.searchHits.length})`)
    const clearBtn = el('button', 'btn-ghost btn-xs', 'Clear')
    clearBtn.type = 'button'
    clearBtn.addEventListener('click', () => {
      state.searchQuery = ''
      state.searchHits = undefined
      renderApp()
    })
    head.appendChild(clearBtn)
    body.appendChild(head)
    for (const hit of state.searchHits) {
      const card = el('button', 'session-item')
      card.type = 'button'
      card.appendChild(el('div', 'session-title', hit.title || hit.sessionId))
      card.appendChild(el('div', 'session-preview', hit.snippet))
      card.addEventListener('click', () => {
        state.mobileDrawerOpen = false
        void attachActiveSession(hit.sessionId)
      })
      body.appendChild(card)
    }
    return
  }

  const queryLower = state.searchQuery.trim().toLowerCase()
  const filtered = state.sessions.filter((s) => {
    if (!queryLower) return true
    return (
      (s.title ?? '').toLowerCase().includes(queryLower) ||
      s.id.toLowerCase().includes(queryLower) ||
      (s.workspace?.branch ?? '').toLowerCase().includes(queryLower) ||
      (s.engine ?? '').toLowerCase().includes(queryLower)
    )
  })

  // Needs Attention group
  const needsAttention = filtered.filter((s) => {
    const tl = state.timelines.get(s.id)
    const pendingCount =
      (s.pendingApprovals ?? 0) +
      (s.pendingQuestions ?? 0) +
      (tl ? tl.pendingApprovals.length + tl.pendingQuestions.length : 0)
    return pendingCount > 0 || (tl?.unreadCount ?? 0) > 0
  })

  if (needsAttention.length > 0) {
    body.appendChild(el('div', 'group-title attention', `Needs Attention (${needsAttention.length})`))
    for (const s of needsAttention) {
      body.appendChild(buildSessionCard(s))
    }
  }

  // Worktree / Repo grouping
  const groups = new Map<string, SessionRef[]>()
  for (const s of filtered) {
    const key =
      s.workspace?.commonRepoRoot ||
      s.workspace?.repoRoot ||
      s.cwd ||
      'Remote Sessions'
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }

  if (groups.size === 0) {
    body.appendChild(el('div', 'empty-muted', 'No remote sessions found on host.'))
    return
  }

  for (const [repoKey, items] of groups) {
    const label = repoKey.split('/').filter(Boolean).pop() ?? repoKey
    body.appendChild(el('div', 'group-title', `${label} (${items.length})`))
    for (const s of items) {
      body.appendChild(buildSessionCard(s))
    }
  }
}

function buildSessionCard(s: SessionRef): HTMLElement {
  const tl = state.timelines.get(s.id)
  const isActive = s.id === state.activeSessionId
  const card = el('button', `session-item${isActive ? ' active' : ''}`)
  card.type = 'button'

  const top = el('div', 'session-row-top')
  const status = tl?.status ?? s.status ?? 'idle'
  top.appendChild(el('span', `dot ${status === 'running' ? 'dot-run' : 'dot-idle'}`))
  top.appendChild(el('span', 'session-title', tl?.title || s.title || s.id))
  top.appendChild(el('span', 'badge engine-badge', engineBadgeLabel(s.engine)))
  card.appendChild(top)

  const meta = el('div', 'session-meta')
  const branchText = s.workspace?.branch ? `${s.workspace.branch}` : ''
  const dirtyText = s.workspace?.dirty ? `*${s.workspace.changedFiles ?? ''}` : ''
  const pendingTotal =
    (tl ? tl.pendingApprovals.length + tl.pendingQuestions.length : 0) ||
    ((s.pendingApprovals ?? 0) + (s.pendingQuestions ?? 0))
  const leftMeta = [branchText, dirtyText, s.workspace?.worktreeName].filter(Boolean).join(' ')
  meta.appendChild(el('span', undefined, leftMeta || s.id.slice(0, 12)))
  if (pendingTotal > 0) {
    meta.appendChild(el('span', 'badge warn-badge', `${pendingTotal} action`))
  } else if (tl && tl.unreadCount > 0) {
    meta.appendChild(el('span', 'badge info-badge', `${tl.unreadCount} new`))
  }
  card.appendChild(meta)

  if (s.preview) {
    card.appendChild(el('div', 'session-preview', s.preview))
  }

  card.addEventListener('click', () => {
    state.mobileDrawerOpen = false
    void attachActiveSession(s.id)
  })
  return card
}

function renderSidebar(aside: HTMLElement): void {
  aside.replaceChildren()
  aside.className = `sidebar${state.mobileDrawerOpen ? ' open' : ''}`

  const head = el('div', 'sidebar-header')
  const newBtn = el('button', 'btn-primary btn-sm', state.newSessionOpen ? 'Cancel' : '+ New Session')
  newBtn.type = 'button'
  newBtn.addEventListener('click', () => {
    state.newSessionOpen = !state.newSessionOpen
    renderSidebar(aside)
  })
  const refreshBtn = el('button', 'btn-ghost btn-sm', 'Sync')
  refreshBtn.type = 'button'
  refreshBtn.addEventListener('click', () => {
    void refreshWorkspaceData()
  })
  const closeDrawer = el('button', 'btn-ghost btn-sm mobile-only', 'Close')
  closeDrawer.type = 'button'
  closeDrawer.addEventListener('click', () => {
    state.mobileDrawerOpen = false
    renderApp()
  })
  head.append(newBtn, refreshBtn, closeDrawer)
  aside.appendChild(head)

  if (state.newSessionOpen) {
    aside.appendChild(buildNewSessionForm())
  }

  const searchBar = el('form', 'search-bar')
  const searchInput = el('input', 'input-sm')
  searchInput.type = 'search'
  searchInput.placeholder = 'Filter or search host logs...'
  searchInput.value = state.searchQuery
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value
    renderSidebarBodyOnly()
  })
  const searchBtn = el('button', 'btn-ghost btn-sm', 'Search')
  searchBtn.type = 'submit'
  searchBar.addEventListener('submit', (evt) => {
    evt.preventDefault()
    const q = state.searchQuery.trim()
    if (!q) {
      state.searchHits = undefined
      renderSidebarBodyOnly()
      return
    }
    void client
      .searchSessions(q)
      .then((res) => {
        state.searchHits = [...res.hits]
        renderSidebarBodyOnly()
      })
      .catch((err) => showToast(err instanceof Error ? err.message : String(err)))
  })
  searchBar.append(searchInput, searchBtn)
  aside.appendChild(searchBar)

  const listWrap = el('div', 'sidebar-list')
  listWrap.id = 'sidebar-sessions'
  aside.appendChild(listWrap)
  renderSidebarBodyOnly()
}

function buildNewSessionForm(): HTMLElement {
  const form = el('form', 'new-session-card')
  const engineSel = el('select', 'input-sm')
  const engines =
    state.engines.length > 0
      ? state.engines.filter((e) => e.capabilities.createSession)
      : ([{ id: 'dsh', displayName: 'DeepSeek Harness (DSH)', available: true, running: true }] as unknown as EngineDescriptor[])
  for (const eng of engines) {
    const opt = el('option', undefined, `${eng.displayName}${eng.available ? '' : ' (unavailable)'}`)
    opt.value = eng.id
    engineSel.appendChild(opt)
  }

  const titleInput = el('input', 'input-sm')
  titleInput.type = 'text'
  titleInput.placeholder = 'Session title (optional)'

  const cwdInput = el('input', 'input-sm')
  cwdInput.type = 'text'
  cwdInput.placeholder = 'Workspace CWD path (optional)'

  const createBtn = el('button', 'btn-primary btn-sm', 'Create Session')
  createBtn.type = 'submit'

  form.addEventListener('submit', (evt) => {
    evt.preventDefault()
    createBtn.disabled = true
    void client
      .createSession({
        engine: engineSel.value,
        ...(titleInput.value.trim() ? { title: titleInput.value.trim() } : {}),
        ...(cwdInput.value.trim() ? { cwd: cwdInput.value.trim() } : {}),
      })
      .then(async (created) => {
        state.newSessionOpen = false
        state.mobileDrawerOpen = false
        await refreshWorkspaceData()
        await attachActiveSession(created.id)
      })
      .catch((err) => showToast(`Create failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        createBtn.disabled = false
      })
  })

  form.append(
    el('label', 'field-label', 'Agent Engine'),
    engineSel,
    el('label', 'field-label', 'Title'),
    titleInput,
    el('label', 'field-label', 'Worktree / Directory'),
    cwdInput,
    createBtn,
  )
  return form
}

function renderTimelineArea(): void {
  const host = document.getElementById('chat-scroll')
  if (!host) return
  host.replaceChildren()

  const sid = state.activeSessionId
  if (!sid) {
    host.appendChild(el('div', 'empty-center', 'Select or create a session to begin.'))
    return
  }
  const tl = getOrCreateTimeline(sid)

  if (tl.hasMoreHistory && tl.oldestSeq !== null) {
    const moreWrap = el('div', 'history-more-wrap')
    const moreBtn = el('button', 'btn-ghost btn-sm', 'Load Earlier History')
    moreBtn.type = 'button'
    moreBtn.addEventListener('click', () => {
      void loadOlderHistory()
    })
    moreWrap.appendChild(moreBtn)
    host.appendChild(moreWrap)
  }

  if (tl.todos.length > 0) {
    const todoDetails = el('details', 'todo-card')
    const done = tl.todos.filter((t) => t.status === 'completed').length
    const todoKey = `todo:${sid}`
    todoDetails.open = state.expandedDetailIds.has(todoKey)
    todoDetails.addEventListener('toggle', () => {
      if (todoDetails.open) state.expandedDetailIds.add(todoKey)
      else state.expandedDetailIds.delete(todoKey)
    })
    todoDetails.appendChild(el('summary', undefined, `Task Checklist (${done}/${tl.todos.length})`))
    const ul = el('ul', 'todo-list')
    for (const item of tl.todos) {
      const li = el('li', item.status === 'completed' ? 'done' : undefined, `[${item.status}] ${item.content}`)
      ul.appendChild(li)
    }
    todoDetails.appendChild(ul)
    host.appendChild(todoDetails)
  }

  if (tl.items.length === 0) {
    host.appendChild(el('div', 'empty-center', 'Connected over E2EE Noise IK. Send a prompt below!'))
    return
  }

  for (const item of tl.items) {
    if (item.kind === 'user') {
      const msg = el('div', 'msg-card msg-user')
      const body = el('div', 'msg-user-text', item.text)
      msg.appendChild(body)
      if (item.attachments.length > 0) {
        const atts = el('div', 'att-row')
        for (const a of item.attachments) {
          atts.appendChild(el('span', 'badge', a))
        }
        msg.appendChild(atts)
      }
      host.appendChild(msg)
      continue
    }

    if (item.kind === 'assistant') {
      const msg = el('div', 'msg-card msg-assistant')
      if (item.thinkingText) {
        const det = el('details', 'thinking-box')
        const dKey = `think:${item.id}`
        det.open = state.expandedDetailIds.has(dKey)
        det.addEventListener('toggle', () => {
          if (det.open) state.expandedDetailIds.add(dKey)
          else state.expandedDetailIds.delete(dKey)
        })
        det.appendChild(el('summary', undefined, 'Reasoning / Thinking'))
        det.appendChild(el('pre', 'thinking-pre', item.thinkingText))
        msg.appendChild(det)
      }
      if (item.markdownText) {
        msg.appendChild(renderMarkdown(document, item.markdownText))
      } else if (!item.finalized) {
        msg.appendChild(el('div', 'streaming-dot', 'Thinking...'))
      }
      if (item.interrupted) {
        msg.appendChild(el('div', 'interrupted-tag', 'Stopped'))
      }
      host.appendChild(msg)
      continue
    }

    if (item.kind === 'tool') {
      const det = el('details', `tool-card tool-${item.status}`)
      const tKey = `tool:${item.id}`
      det.open = state.expandedDetailIds.has(tKey)
      det.addEventListener('toggle', () => {
        if (det.open) state.expandedDetailIds.add(tKey)
        else state.expandedDetailIds.delete(tKey)
      })
      const sum = el('summary', 'tool-summary')
      sum.appendChild(el('span', `badge tool-st-${item.status}`, item.status.toUpperCase()))
      sum.appendChild(el('span', 'tool-name', item.toolName))
      det.appendChild(sum)
      const body = el('div', 'tool-body')
      if (item.argumentsText) {
        body.appendChild(el('div', 'field-label', 'Arguments'))
        body.appendChild(el('pre', 'tool-pre', item.argumentsText))
      }
      if (item.outputText) {
        body.appendChild(el('div', 'field-label', 'Output'))
        body.appendChild(el('pre', 'tool-pre', item.outputText))
      }
      det.appendChild(body)
      host.appendChild(det)
      continue
    }

    if (item.kind === 'notice') {
      host.appendChild(el('div', `notice-card${item.isError ? ' err' : ''}`, item.text))
    }
  }
}

function renderPendingActionsTray(): void {
  const tray = document.getElementById('pending-actions-tray')
  if (!tray) return
  tray.replaceChildren()
  if (!state.activeSessionId) return
  const tl = state.timelines.get(state.activeSessionId)
  if (!tl) return

  for (const approval of tl.pendingApprovals) {
    tray.appendChild(buildApprovalCard(approval))
  }
  for (const question of tl.pendingQuestions) {
    tray.appendChild(buildQuestionCard(question))
  }
}

function buildApprovalCard(approval: PendingApprovalSnapshot): HTMLElement {
  const card = el('div', 'action-card approval-card')
  card.appendChild(el('div', 'action-title', `Approval Required: ${approval.toolName}`))
  if (approval.reason || approval.summary) {
    card.appendChild(el('div', 'action-detail', approval.summary ?? approval.reason ?? ''))
  }
  const btns = el('div', 'action-buttons')
  const allowBtn = el('button', 'btn-primary btn-sm', 'Allow Once')
  allowBtn.type = 'button'
  const rejectBtn = el('button', 'btn-danger btn-sm', 'Reject')
  rejectBtn.type = 'button'
  const diffBtn = el('button', 'btn-ghost btn-sm', 'Inspect Diff')
  diffBtn.type = 'button'

  const resolveDecision = async (decision: 'approved' | 'rejected'): Promise<void> => {
    allowBtn.disabled = true
    rejectBtn.disabled = true
    try {
      await client.respondApproval(approval.callId, decision)
      if (state.activeSessionId) {
        getOrCreateTimeline(state.activeSessionId).resolveApprovalLocally(approval.callId)
      }
      renderPendingActionsTray()
      renderSidebarBodyOnly()
    } catch (err) {
      showToast(`Approval failed: ${err instanceof Error ? err.message : String(err)}`)
      allowBtn.disabled = false
      rejectBtn.disabled = false
    }
  }

  allowBtn.addEventListener('click', () => void resolveDecision('approved'))
  rejectBtn.addEventListener('click', () => void resolveDecision('rejected'))
  diffBtn.addEventListener('click', () => {
    state.activeTab = 'diff'
    if (state.activeSessionId) void loadGitReview(state.activeSessionId)
    renderApp()
  })

  btns.append(allowBtn, rejectBtn, diffBtn)
  card.appendChild(btns)
  return card
}

function buildQuestionCard(q: PendingQuestionSnapshot): HTMLElement {
  const card = el('div', 'action-card question-card')
  card.appendChild(el('div', 'action-title', 'Agent Question'))

  const qList = q.questions && q.questions.length > 0 ? q.questions : [{ question: q.prompt }]
  const draftMap = state.questionDrafts.get(q.questionId) ?? new Map<number, string[]>()
  state.questionDrafts.set(q.questionId, draftMap)

  qList.forEach((promptItem, idx) => {
    const qBlock = el('div', 'q-block')
    if (promptItem.header) {
      qBlock.appendChild(el('div', 'badge', promptItem.header))
    }
    qBlock.appendChild(el('div', 'action-detail', promptItem.question))

    if (promptItem.options && promptItem.options.length > 0) {
      const optWrap = el('div', 'q-options')
      for (const opt of promptItem.options) {
        const selected = draftMap.get(idx) ?? []
        const isSel = selected.includes(opt.label)
        const optBtn = el('button', `q-opt-btn${isSel ? ' selected' : ''}`)
        optBtn.type = 'button'
        optBtn.appendChild(el('strong', undefined, opt.label))
        if (opt.description) {
          optBtn.appendChild(el('span', 'q-opt-desc', opt.description))
        }
        optBtn.addEventListener('click', () => {
          if (promptItem.multiSelect) {
            const cur = new Set(draftMap.get(idx) ?? [])
            if (cur.has(opt.label)) cur.delete(opt.label)
            else cur.add(opt.label)
            draftMap.set(idx, [...cur])
            renderPendingActionsTray()
          } else {
            draftMap.set(idx, [opt.label])
            if (qList.length === 1) {
              void sendQuestionAnswer(q, opt.label)
            } else {
              renderPendingActionsTray()
            }
          }
        })
        optWrap.appendChild(optBtn)
      }
      qBlock.appendChild(optWrap)
    }
    card.appendChild(qBlock)
  })

  const customRow = el('form', 'q-custom-row')
  const customInput = el('input', 'input-sm')
  customInput.type = 'text'
  customInput.placeholder = 'Or type a custom answer...'
  const sendBtn = el('button', 'btn-primary btn-sm', 'Submit Answer')
  sendBtn.type = 'submit'
  const cancelBtn = el('button', 'btn-ghost btn-sm', 'Cancel')
  cancelBtn.type = 'button'

  customRow.addEventListener('submit', (evt) => {
    evt.preventDefault()
    const typed = customInput.value.trim()
    if (typed && qList.length === 1) {
      void sendQuestionAnswer(q, typed)
      return
    }
    const answers = qList.map((p, i) => ({
      question: p.question,
      selected: draftMap.get(i) ?? (typed ? [typed] : []),
    }))
    void sendQuestionAnswer(q, { answers })
  })

  cancelBtn.addEventListener('click', () => {
    void sendQuestionAnswer(q, { cancelled: true })
  })

  customRow.append(customInput, sendBtn, cancelBtn)
  card.appendChild(customRow)
  return card
}

async function sendQuestionAnswer(q: PendingQuestionSnapshot, answer: unknown): Promise<void> {
  try {
    await client.respondQuestion(q.questionId, answer)
    state.questionDrafts.delete(q.questionId)
    if (state.activeSessionId) {
      getOrCreateTimeline(state.activeSessionId).resolveQuestionLocally(q.questionId)
    }
    renderPendingActionsTray()
    renderSidebarBodyOnly()
  } catch (err) {
    showToast(`Question reply failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function renderComposer(): void {
  const host = document.getElementById('composer-slot')
  if (!host) return
  host.replaceChildren()
  const sid = state.activeSessionId
  if (!sid || state.activeTab !== 'chat') return
  const tl = getOrCreateTimeline(sid)
  const cmds = state.commandsBySession.get(sid) ?? []

  if (state.pendingAttachments.length > 0) {
    const attBar = el('div', 'composer-attachments')
    state.pendingAttachments.forEach((att, idx) => {
      const chip = el('span', 'badge')
      chip.textContent = att.name ?? 'image'
      const rmBtn = el('button', 'btn-ghost btn-xs', 'x')
      rmBtn.type = 'button'
      rmBtn.addEventListener('click', () => {
        state.pendingAttachments = state.pendingAttachments.filter((_, i) => i !== idx)
        renderComposer()
      })
      chip.appendChild(rmBtn)
      attBar.appendChild(chip)
    })
    host.appendChild(attBar)
  }

  const form = el('form', 'composer-box')
  const controls = el('div', 'composer-controls')

  const fileInput = el('input', 'hidden-input')
  fileInput.type = 'file'
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif'
  fileInput.multiple = true
  fileInput.addEventListener('change', () => {
    void handleImagePick(fileInput.files)
    fileInput.value = ''
  })

  const imgBtn = el('button', 'btn-ghost btn-xs', '+ Image')
  imgBtn.type = 'button'
  imgBtn.addEventListener('click', () => fileInput.click())

  if (tl.status === 'running') {
    const modeBtn = el(
      'button',
      'btn-ghost btn-xs',
      `Mode: ${state.promptMode === 'steer' ? 'Steer' : 'Followup'}`,
    )
    modeBtn.type = 'button'
    modeBtn.addEventListener('click', () => {
      state.promptMode = state.promptMode === 'followup' ? 'steer' : 'followup'
      renderComposer()
    })
    controls.appendChild(modeBtn)
  }

  if (cmds.length > 0) {
    const cmdSel = el('select', 'cmd-select')
    const placeholder = el('option', undefined, '/ Commands...')
    placeholder.value = ''
    cmdSel.appendChild(placeholder)
    for (const c of cmds) {
      const opt = el('option', undefined, `/${c.name} — ${c.description.slice(0, 40)}`)
      opt.value = `/${c.name}`
      cmdSel.appendChild(opt)
    }
    cmdSel.addEventListener('change', () => {
      if (!cmdSel.value) return
      const cur = state.draftBySession.get(sid) ?? ''
      state.draftBySession.set(sid, cur ? `${cur}\n${cmdSel.value}` : `${cmdSel.value} `)
      cmdSel.value = ''
      renderComposer()
    })
    controls.appendChild(cmdSel)
  }

  controls.append(fileInput, imgBtn)

  const row = el('div', 'composer-input-row')
  const textarea = el('textarea', 'composer-textarea')
  textarea.rows = 2
  textarea.placeholder = 'Message agent over E2EE Noise channel... (/diff to inspect changes)'
  textarea.value = state.draftBySession.get(sid) ?? ''
  textarea.addEventListener('input', () => {
    state.draftBySession.set(sid, textarea.value)
  })
  textarea.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' && !evt.shiftKey && !evt.isComposing) {
      evt.preventDefault()
      void handleSubmitPrompt()
    }
  })

  if (tl.status === 'running') {
    const stopBtn = el('button', 'btn-danger btn-sm', 'Stop')
    stopBtn.type = 'button'
    stopBtn.addEventListener('click', () => {
      void client.abortTurn(sid).catch((err) => showToast(String(err)))
    })
    row.appendChild(stopBtn)
  }

  const sendBtn = el('button', 'btn-primary btn-sm', state.submittingPrompt ? '...' : 'Send')
  sendBtn.type = 'submit'
  sendBtn.disabled = state.submittingPrompt || client.getStatus() !== 'active'
  row.append(textarea, sendBtn)

  form.addEventListener('submit', (evt) => {
    evt.preventDefault()
    void handleSubmitPrompt()
  })

  form.append(controls, row)
  host.appendChild(form)
}

function renderGitDiffPanel(container: HTMLElement): void {
  container.replaceChildren()
  const sid = state.activeSessionId
  if (!sid) {
    container.appendChild(el('div', 'empty-center', 'Select a session to inspect workspace git changes.'))
    return
  }

  const toolbar = el('div', 'diff-toolbar')
  const st = state.gitStatus
  if (st) {
    const summary = el(
      'div',
      'diff-branch-meta',
      `${st.branch}${st.ahead || st.behind ? ` (↑${st.ahead} ↓${st.behind})` : ''} • ${st.clean ? 'Clean' : `${st.files.length} changed`}`,
    )
    toolbar.appendChild(summary)
  }

  const filters = el('div', 'diff-filter-btns')
  const unstagedBtn = el('button', `btn-sm ${!state.gitStaged ? 'btn-primary' : 'btn-ghost'}`, 'Unstaged')
  unstagedBtn.type = 'button'
  unstagedBtn.addEventListener('click', () => {
    state.gitStaged = false
    void loadGitReview(sid)
  })
  const stagedBtn = el('button', `btn-sm ${state.gitStaged ? 'btn-primary' : 'btn-ghost'}`, 'Staged')
  stagedBtn.type = 'button'
  stagedBtn.addEventListener('click', () => {
    state.gitStaged = true
    void loadGitReview(sid)
  })
  const refreshBtn = el('button', 'btn-ghost btn-sm', state.gitLoading ? 'Loading...' : 'Refresh')
  refreshBtn.type = 'button'
  refreshBtn.addEventListener('click', () => void loadGitReview(sid))
  filters.append(unstagedBtn, stagedBtn, refreshBtn)
  toolbar.appendChild(filters)
  container.appendChild(toolbar)

  if (state.gitError) {
    container.appendChild(el('div', 'notice-card err', state.gitError))
    return
  }

  if (st && st.files.length > 0) {
    const fileBar = el('div', 'diff-files-strip')
    const allChip = el(
      'button',
      `chip-btn${state.gitSelectedPath === undefined ? ' active' : ''}`,
      `All (${st.files.length})`,
    )
    allChip.type = 'button'
    allChip.addEventListener('click', () => {
      state.gitSelectedPath = undefined
      void loadGitReview(sid)
    })
    fileBar.appendChild(allChip)
    for (const f of st.files) {
      const chip = el(
        'button',
        `chip-btn${state.gitSelectedPath === f.path ? ' active' : ''}`,
        `${f.indexStatus}${f.worktreeStatus} ${f.path}`,
      )
      chip.type = 'button'
      chip.addEventListener('click', () => {
        state.gitSelectedPath = f.path
        void loadGitReview(sid)
      })
      fileBar.appendChild(chip)
    }
    container.appendChild(fileBar)
  }

  const diffWrap = el('div', 'diff-scroll')
  if (state.gitDiff) {
    if (state.gitDiff.truncated) {
      diffWrap.appendChild(
        el('div', 'notice-card', `Diff truncated to ${state.gitDiff.bytes} bytes. Select a single file above.`),
      )
    }
    diffWrap.appendChild(renderUnifiedDiff(document, state.gitDiff.diff))
  } else if (!state.gitLoading) {
    diffWrap.appendChild(el('div', 'empty-center', 'Tap Refresh to inspect git diff.'))
  }
  container.appendChild(diffWrap)
}

function renderMainBody(): void {
  const main = document.getElementById('workspace-main')
  if (!main) return
  main.replaceChildren()

  const subbar = el('div', 'workspace-subbar')
  const tabs = el('div', 'tab-group')
  const chatTab = el('button', `tab-btn${state.activeTab === 'chat' ? ' active' : ''}`, 'Chat')
  chatTab.type = 'button'
  chatTab.addEventListener('click', () => {
    state.activeTab = 'chat'
    renderApp()
  })
  const changedCount = state.gitStatus?.files.length ?? getActiveSession()?.workspace?.changedFiles ?? 0
  const diffTab = el(
    'button',
    `tab-btn${state.activeTab === 'diff' ? ' active' : ''}`,
    `Git Diff${changedCount > 0 ? ` (${changedCount})` : ''}`,
  )
  diffTab.type = 'button'
  diffTab.addEventListener('click', () => {
    state.activeTab = 'diff'
    if (state.activeSessionId) {
      void loadGitReview(state.activeSessionId)
    }
    renderApp()
  })
  tabs.append(chatTab, diffTab)
  subbar.appendChild(tabs)

  const sid = state.activeSessionId
  if (sid) {
    const tl = state.timelines.get(sid)
    const actions = el('div', 'subbar-actions')
    if (tl?.usage) {
      actions.appendChild(
        el('span', 'badge', `${tl.usage.totalTokens.toLocaleString()} tok`),
      )
    }
    const forkBtn = el('button', 'btn-ghost btn-xs', 'Fork')
    forkBtn.type = 'button'
    forkBtn.addEventListener('click', () => {
      void client
        .forkSession(sid)
        .then(async (forked) => {
          await refreshWorkspaceData()
          await attachActiveSession(forked.id)
        })
        .catch((err) => showToast(`Fork failed: ${err instanceof Error ? err.message : String(err)}`))
    })
    const renameBtn = el('button', 'btn-ghost btn-xs', 'Rename')
    renameBtn.type = 'button'
    renameBtn.addEventListener('click', () => {
      const cur = tl?.title ?? getActiveSession()?.title ?? ''
      const next = typeof globalThis.prompt === 'function' ? globalThis.prompt('New session title:', cur) : null
      if (next && next.trim()) {
        void client
          .renameSession(sid, next.trim())
          .then(() => refreshWorkspaceData())
          .catch((err) => showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    })
    actions.append(forkBtn, renameBtn)
    subbar.appendChild(actions)
  }
  main.appendChild(subbar)

  if (state.activeTab === 'diff') {
    const diffHost = el('div', 'diff-container')
    main.appendChild(diffHost)
    renderGitDiffPanel(diffHost)
    return
  }

  const chatScroll = el('div', 'chat-scroll')
  chatScroll.id = 'chat-scroll'
  const pendingTray = el('div', 'pending-tray')
  pendingTray.id = 'pending-actions-tray'
  const composerSlot = el('div', 'composer-slot')
  composerSlot.id = 'composer-slot'
  main.append(chatScroll, pendingTray, composerSlot)

  renderTimelineArea()
  renderPendingActionsTray()
  renderComposer()
}

function renderOnboardingView(root: HTMLElement): void {
  const wrap = el('div', 'onboarding-wrap')
  const hero = el('section', 'onboard-card')
  hero.appendChild(el('h1', undefined, 'DSH Community Remote Web'))
  hero.appendChild(
    el(
      'p',
      'muted',
      'Zero-install browser & iPhone Safari PWA client. End-to-end encrypted with Noise_IK_25519_ChaChaPoly_BLAKE2b before frames leave your device.',
    ),
  )

  if (state.identity) {
    const fpPill = el('div', 'device-fp-box')
    fpPill.appendChild(el('span', 'field-label', 'This Browser Device Fingerprint (SHA-256)'))
    fpPill.appendChild(el('code', 'mono-line', shortFp(state.identity.fingerprint)))
    hero.appendChild(fpPill)
  }

  if (state.pairingError) {
    hero.appendChild(el('div', 'notice-card err', state.pairingError))
  }

  const form = el('form', 'pair-form')
  const textarea = el('textarea', 'pair-textarea')
  textarea.rows = 4
  textarea.placeholder = 'Paste dsh-remote://pair?data=..., companion #pair= URL, or QR bootstrap JSON...'
  textarea.value = state.pairingInput
  textarea.addEventListener('input', () => {
    state.pairingInput = textarea.value
    if (textarea.value.trim().length > 10) {
      void parsePairingInput(textarea.value)
        .then((preview) => {
          state.parsedPreview = preview
          state.pairingError = undefined
        })
        .catch(() => {
          state.parsedPreview = undefined
        })
    }
  })

  const btnRow = el('div', 'pair-btn-row')
  const pairBtn = el('button', 'btn-primary', 'Verify & Pair E2EE')
  pairBtn.type = 'submit'

  const scanBtn = el('button', 'btn-ghost', isBarcodeDetectorSupported() ? 'Scan QR Camera' : 'Upload QR Image')
  scanBtn.type = 'button'
  scanBtn.addEventListener('click', () => {
    if (isBarcodeDetectorSupported()) {
      state.qrModalOpen = true
      renderApp()
    } else {
      qrFileInput.click()
    }
  })

  const qrFileInput = el('input', 'hidden-input')
  qrFileInput.type = 'file'
  qrFileInput.accept = 'image/*'
  qrFileInput.addEventListener('change', () => {
    const f = qrFileInput.files?.[0]
    if (!f) return
    void decodeQrFromImageFile(f)
      .then((raw) => {
        state.pairingInput = raw
        return handleConnectPairing(raw)
      })
      .catch((err) => {
        state.pairingError = err instanceof Error ? err.message : String(err)
        renderApp()
      })
    qrFileInput.value = ''
  })

  form.addEventListener('submit', (evt) => {
    evt.preventDefault()
    void handleConnectPairing(textarea.value)
  })
  btnRow.append(pairBtn, scanBtn, qrFileInput)
  form.append(el('label', 'field-label', 'Pairing Link / QR Payload'), textarea, btnRow)
  hero.appendChild(form)

  if (state.savedHosts.length > 0) {
    const savedCard = el('section', 'onboard-card')
    savedCard.appendChild(el('h2', undefined, 'Trusted Hosts'))
    for (const host of state.savedHosts) {
      const row = el('div', 'saved-host-row')
      const info = el('div', 'saved-host-info')
      info.appendChild(el('strong', undefined, host.label))
      info.appendChild(
        el(
          'div',
          'muted small',
          `FP ${shortFp(host.hostFingerprint)} • Epoch ${host.lastEpoch} • ${host.endpointUrl}`,
        ),
      )
      const acts = el('div', 'saved-host-actions')
      const connBtn = el('button', 'btn-primary btn-sm', 'Reconnect')
      connBtn.type = 'button'
      connBtn.addEventListener('click', () => void handleConnectSavedHost(host, false))
      const forgetBtn = el('button', 'btn-ghost btn-sm', 'Forget')
      forgetBtn.type = 'button'
      forgetBtn.addEventListener('click', () => {
        void keyStore.forgetHost(host.hostFingerprint).then(async () => {
          state.savedHosts = await keyStore.listTrustedHosts()
          renderApp()
        })
      })
      acts.append(connBtn, forgetBtn)
      row.append(info, acts)
      savedCard.appendChild(row)
    }
    wrap.append(hero, savedCard)
  } else {
    wrap.appendChild(hero)
  }

  root.appendChild(wrap)
}

function renderModals(root: HTMLElement): void {
  if (state.securityModalOpen) {
    const backdrop = el('div', 'modal-backdrop')
    const modal = el('div', 'modal-card')
    modal.appendChild(el('h2', undefined, 'Device Identity & E2EE Keys'))
    if (state.identity) {
      modal.appendChild(el('div', 'field-label', 'Client Static Public Key SHA-256'))
      modal.appendChild(el('code', 'mono-block', state.identity.fingerprint))
    }
    if (state.statusEvt.host) {
      modal.appendChild(el('div', 'field-label', 'Connected Host Fingerprint'))
      modal.appendChild(el('code', 'mono-block', state.statusEvt.host.hostFingerprint))
      modal.appendChild(
        el(
          'div',
          'muted small',
          `Transport: ${state.statusEvt.transport ?? 'none'} • Monotonic Epoch: ${client.getConnectionEpoch() || state.statusEvt.host.lastEpoch}`,
        ),
      )
    }

    const row = el('div', 'modal-actions')
    if (client.getStatus() !== 'disconnected') {
      const discBtn = el('button', 'btn-ghost btn-sm', 'Disconnect')
      discBtn.type = 'button'
      discBtn.addEventListener('click', () => {
        client.disconnect()
        state.securityModalOpen = false
        renderApp()
      })
      row.appendChild(discBtn)
    }
    const rotateBtn = el('button', 'btn-danger btn-sm', 'Rotate Client X25519 Key')
    rotateBtn.type = 'button'
    rotateBtn.addEventListener('click', () => {
      client.disconnect()
      void keyStore.rotateClientKeyPair().then(async (nextId) => {
        state.identity = nextId
        state.securityModalOpen = false
        showToast('Rotated client X25519 identity. Pair again on host with new QR/link.')
        renderApp()
      })
    })
    const closeBtn = el('button', 'btn-primary btn-sm', 'Close')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', () => {
      state.securityModalOpen = false
      renderApp()
    })
    row.append(rotateBtn, closeBtn)
    modal.appendChild(row)
    backdrop.appendChild(modal)
    root.appendChild(backdrop)
  }

  if (state.modelModalOpen && state.activeSessionId) {
    const sid = state.activeSessionId
    const catalog = state.modelsBySession.get(sid)
    const backdrop = el('div', 'modal-backdrop')
    const modal = el('div', 'modal-card')
    modal.appendChild(el('h2', undefined, 'Select Model & Reasoning Effort'))

    if (!catalog || catalog.models.length === 0) {
      modal.appendChild(el('p', 'muted', 'No remote model catalog reported for this engine.'))
    } else {
      const list = el('div', 'model-list')
      for (const m of catalog.models) {
        const card = el('div', 'model-row')
        const title = el('strong', undefined, `${m.name} (${m.provider}/${m.model})`)
        card.appendChild(title)
        const btns = el('div', 'model-efforts')
        const efforts = m.reasoningEfforts && m.reasoningEfforts.length > 0 ? m.reasoningEfforts : [{ id: '', name: 'Default' }]
        for (const eff of efforts) {
          const btn = el('button', 'btn-ghost btn-xs', eff.name)
          btn.type = 'button'
          btn.addEventListener('click', () => {
            const selection: ModelSelectionParams = {
              provider: m.provider,
              model: m.model,
              ...(eff.id ? { reasoningEffort: eff.id } : {}),
            }
            void client
              .selectModel(sid, selection)
              .then(() => {
                getOrCreateTimeline(sid).model = selection
                state.modelModalOpen = false
                renderApp()
              })
              .catch((err) => showToast(`Model switch failed: ${err instanceof Error ? err.message : String(err)}`))
          })
          btns.appendChild(btn)
        }
        card.appendChild(btns)
        list.appendChild(card)
      }
      modal.appendChild(list)
    }

    const closeBtn = el('button', 'btn-primary btn-sm', 'Close')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', () => {
      state.modelModalOpen = false
      renderApp()
    })
    modal.appendChild(closeBtn)
    backdrop.appendChild(modal)
    root.appendChild(backdrop)
  }

  if (state.qrModalOpen) {
    const backdrop = el('div', 'modal-backdrop')
    const modal = el('div', 'modal-card')
    modal.appendChild(el('h2', undefined, 'Scan Host Pairing QR'))
    const video = el('video', 'qr-video')
    video.playsInline = true
    video.muted = true
    const msg = el('div', 'muted small', 'Point camera at the DSH Desktop / CLI pairing QR code.')
    const closeBtn = el('button', 'btn-ghost btn-sm', 'Cancel Scan')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', () => {
      activeCameraScanner?.stop()
      activeCameraScanner = undefined
      state.qrModalOpen = false
      renderApp()
    })
    modal.append(video, msg, closeBtn)
    backdrop.appendChild(modal)
    root.appendChild(backdrop)

    void startCameraQrScanner({
      videoElement: video,
      onDetected: (payload) => {
        activeCameraScanner = undefined
        state.qrModalOpen = false
        state.pairingInput = payload
        void handleConnectPairing(payload)
      },
      onError: (err) => {
        activeCameraScanner = undefined
        msg.textContent = err.message
      },
    })
      .then((scanner) => {
        activeCameraScanner = scanner
      })
      .catch((err) => {
        msg.textContent = err instanceof Error ? err.message : String(err)
      })
  }
}

function renderApp(): void {
  const root = document.getElementById('app')
  if (!root) return
  root.replaceChildren()

  const header = el('header', 'topbar')
  renderTopHeader(header)
  const bannerSlot = el('div', 'banner-slot')
  bannerSlot.id = 'banner-slot'
  const toastSlot = el('div', 'toast-slot')
  toastSlot.id = 'toast-slot'
  root.append(header, bannerSlot, toastSlot)

  const connectedEnough =
    state.statusEvt.status === 'active' ||
    (state.statusEvt.status === 'reconnecting' && state.sessions.length > 0) ||
    (state.sessions.length > 0 && state.statusEvt.status !== 'disconnected')

  if (!connectedEnough) {
    renderOnboardingView(root)
  } else {
    const layout = el('div', 'workspace-layout')
    const sidebar = el('aside', 'sidebar')
    renderSidebar(sidebar)
    const main = el('main', 'workspace-main')
    main.id = 'workspace-main'
    layout.append(sidebar, main)
    root.appendChild(layout)
    renderMainBody()
  }

  renderBannerAndToast()
  renderModals(root)
  void hexToBytes
  void sha256Hex
}

async function bootstrap(): Promise<void> {
  // Synchronously read and scrub #pair= URL fragment BEFORE network I/O or renders
  const hashPairPayload =
    typeof window !== 'undefined' ? consumePairFragmentFromLocation(window) : undefined

  state.identity = await keyStore.getOrCreateClientKeyPair()
  state.savedHosts = await keyStore.listTrustedHosts()

  client.onStatus((evt) => {
    const prevStatus = state.statusEvt.status
    state.statusEvt = evt
    if (evt.status === 'active' && prevStatus !== 'active') {
      void refreshWorkspaceData()
    } else {
      renderApp()
    }
  })

  client.onNotification((notif) => {
    if (notif.type === 'stream.event') {
      const tl = getOrCreateTimeline(notif.sessionId)
      tl.applyEvent(notif.event, {
        markUnread: notif.sessionId !== state.activeSessionId,
      })
      if (notif.sessionId === state.activeSessionId) {
        scheduleTimelineRender()
      } else {
        renderSidebarBodyOnly()
      }
      return
    }
    if (notif.type === 'stream.reset') {
      showToast(`Session stream reset: ${notif.reason}`)
      if (notif.sessionId === state.activeSessionId) {
        void attachActiveSession(notif.sessionId)
      }
      return
    }
    if (notif.type === 'peer.revoked') {
      showToast(`Host revoked access: ${notif.reason}`)
      renderApp()
    }
  })

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined') {
    if (window.isSecureContext) {
      void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {})
    }
  }

  renderApp()

  if (hashPairPayload) {
    state.pairingInput = hashPairPayload
    await handleConnectPairing(hashPairPayload)
  }
}

void bootstrap()
