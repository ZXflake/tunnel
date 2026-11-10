<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ConnectionInput, ConnectionView, ProtocolKind } from '@shared/types'
import { api } from '../api'

const props = defineProps<{
  connections: ConnectionView[]
  protocols: string[]
  selectedId: string
  downloadsDir: string
}>()
const emit = defineEmits<{
  select: [id: string]
  refresh: []
  notify: [message: string]
  collapse: []
}>()

const DEFAULT_PORTS: Record<string, number> = { ftp: 21, sftp: 22, smb: 445 }
const PROTOCOL_LABELS: Record<string, string> = {
  ftp: 'FTP / FTPS',
  sftp: 'SFTP',
  smb: 'SMB (2.02+)',
}

function emptyDraft(): ConnectionInput {
  return {
    protocol: 'ftp',
    host: '',
    port: 21,
    name: '',
    username: '',
    password: '',
    savePassword: false,
    basePath: '/',
    options: { passive: true, charset: 'utf8', ftps: false, minDialect: 'SMB2_02' },
  }
}

const dialogOpen = ref(false)
const draft = ref<ConnectionInput>(emptyDraft())
const busy = ref(false)
const error = ref('')
// 模板里避免非空断言，始终保持一个可写的 options 对象
const opts = computed(() => (draft.value.options ??= {}))

watch(
  () => draft.value.protocol,
  (protocol) => {
    draft.value.port = DEFAULT_PORTS[protocol] ?? 21
  },
)

function startCreate(): void {
  draft.value = emptyDraft()
  error.value = ''
  dialogOpen.value = true
}

function startEdit(c: ConnectionView): void {
  draft.value = {
    id: c.id,
    name: c.name,
    protocol: c.protocol as ProtocolKind,
    host: c.host,
    port: c.port,
    username: c.username,
    password: '', // 留空表示沿用已保存的密码
    savePassword: c.savePassword,
    basePath: c.basePath,
    options: { ...c.options },
  }
  error.value = ''
  dialogOpen.value = true
}

function closeDialog(): void {
  if (busy.value) return
  dialogOpen.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && dialogOpen.value) closeDialog()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

async function save(): Promise<void> {
  error.value = ''
  if (!draft.value.host.trim()) {
    error.value = '请填写主机地址'
    return
  }
  busy.value = true
  try {
    const created = await api.saveConnection({
      ...draft.value,
      name: draft.value.name?.trim() || draft.value.host,
      password: draft.value.password || undefined,
    })
    emit('select', created.id)
    // 保存失败时不关闭弹窗，错误留在弹窗内（见 catch）
    dialogOpen.value = false
    emit('refresh')
    emit('notify', '连接配置已保存')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function act(c: ConnectionView, action: 'connect' | 'disconnect' | 'remove'): Promise<void> {
  busy.value = true
  try {
    if (action === 'remove') {
      await api.removeConnection(c.id)
      emit('notify', '连接已删除')
    } else if (action === 'connect') {
      await api.connect(c.id)
      emit('notify', `已连接 ${c.name}`)
    } else {
      await api.disconnect(c.id)
      emit('notify', `已断开 ${c.name}`)
    }
    emit('refresh')
  } catch (err) {
    emit('notify', err instanceof Error ? err.message : String(err))
    emit('refresh')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="panel" style="height: 100%">
    <div class="panel-head">
      <h2>连接管理</h2>
      <div class="spacer"></div>
      <button class="btn small primary" @click="startCreate()">+ 新建</button>
      <button class="btn small ghost collapse-btn" title="收起连接管理" aria-label="收起连接管理" @click="emit('collapse')">«</button>
    </div>

    <div class="panel-body">
      <div class="section-title">已保存的连接（{{ connections.length }}）</div>
      <div v-if="!connections.length" class="empty">还没有连接。<br />点右上角「+ 新建」添加一台 NAS 或服务器。</div>
      <div v-else class="list">
        <div
          v-for="c in connections"
          :key="c.id"
          class="row"
          :class="{ active: c.id === selectedId }"
          @click="emit('select', c.id)"
        >
          <span class="dot" :class="c.state"></span>
          <div class="grow">
            <div class="name">{{ c.name }}</div>
            <div class="meta">
              {{ c.protocol.toUpperCase() }} · {{ c.host }}:{{ c.port }}
              <span v-if="c.state === 'error'"> · 连接失败</span>
            </div>
          </div>
          <button
            v-if="c.state === 'connected'"
            class="btn small ghost"
            title="断开"
            :disabled="busy"
            @click.stop="act(c, 'disconnect')"
          >断开</button>
          <button
            v-else
            class="btn small ghost"
            title="连接"
            :disabled="busy"
            @click.stop="act(c, 'connect')"
          >连接</button>
          <button class="btn small ghost" title="编辑" @click.stop="startEdit(c)">编辑</button>
          <button class="btn small ghost danger" title="删除" @click.stop="act(c, 'remove')">删</button>
        </div>
      </div>

      <div class="divider"></div>
      <div class="hint">
        密码保存在本机系统安全存储中，绝不写入明文配置。<br />
        Windows / macOS 的 SMB 由系统协议栈处理；Linux 使用包内原生模块。
      </div>
    </div>
  </div>

  <!-- 新建 / 编辑改为弹窗：字段铺得开，且不再把连接列表往下顶 -->
  <Teleport to="body">
    <div v-if="dialogOpen" class="modal-backdrop" @click.self="closeDialog">
      <div class="modal-card connection-modal" role="dialog" aria-modal="true">
        <div class="panel-head">
          <h2>{{ draft.id ? '编辑连接' : '新建连接' }}</h2>
          <div class="spacer"></div>
          <button class="btn small ghost" title="关闭 (ESC)" @click="closeDialog">✕</button>
        </div>
        <div class="panel-body">
          <form @submit.prevent="save">
            <div class="field">
              <label>名称</label>
              <input v-model="draft.name" class="input" placeholder="留空则使用主机地址" />
            </div>
            <div class="grid-2">
              <div class="field">
                <label>协议</label>
                <select v-model="draft.protocol" class="select">
                  <option v-for="p in protocols" :key="p" :value="p">{{ PROTOCOL_LABELS[p] ?? p }}</option>
                </select>
              </div>
              <div class="field">
                <label>端口</label>
                <input v-model.number="draft.port" class="input" type="number" />
              </div>
            </div>
            <div class="field">
              <label>主机地址</label>
              <input v-model="draft.host" class="input" placeholder="192.168.1.10 或 nas.local" required />
            </div>
            <div class="grid-2">
              <div class="field">
                <label>用户名</label>
                <input v-model="draft.username" class="input" autocomplete="off" />
              </div>
              <div class="field">
                <label>密码{{ draft.id ? '（留空沿用已保存的）' : '' }}</label>
                <input v-model="draft.password" class="input" type="password" autocomplete="new-password" />
              </div>
            </div>
            <label class="check" style="margin-bottom: 10px">
              <input v-model="draft.savePassword" type="checkbox" /> 保存密码（系统安全存储加密）
            </label>
            <div class="field">
              <label>远程根目录</label>
              <input v-model="draft.basePath" class="input" placeholder="/" />
            </div>

            <!-- 「协议版本」按协议展开为具体选项，单一版本字段填不出有效值 -->
            <template v-if="draft.protocol === 'ftp'">
              <div class="grid-2">
                <div class="field">
                  <label>FTPS 模式</label>
                  <select v-model="opts.ftps" class="select">
                    <option :value="false">不使用</option>
                    <option value="explicit">显式 TLS</option>
                    <option value="implicit">隐式 TLS (990)</option>
                  </select>
                </div>
                <div class="field">
                  <label>文件名编码</label>
                  <select v-model="opts.charset" class="select">
                    <option value="utf8">UTF-8</option>
                    <option value="latin1">Latin-1 / GBK 回退</option>
                  </select>
                </div>
              </div>
              <label class="check" style="margin-bottom: 10px">
                <input v-model="opts.passive" type="checkbox" /> 被动模式
              </label>
            </template>
            <template v-else-if="draft.protocol === 'sftp'">
              <div class="field">
                <label>私钥（PEM，可选）</label>
                <input v-model="opts.privateKey" class="input" placeholder="留空则用密码登录" />
              </div>
              <div class="field">
                <label>私钥口令</label>
                <input v-model="opts.passphrase" class="input" type="password" />
              </div>
            </template>
            <template v-else>
              <div class="grid-2">
                <div class="field">
                  <label>共享名 share</label>
                  <input v-model="opts.share" class="input" placeholder="例如 share" required />
                </div>
                <div class="field">
                  <label>域（可选）</label>
                  <input v-model="opts.domain" class="input" />
                </div>
              </div>
              <div class="field">
                <label>最低 SMB dialect</label>
                <select v-model="opts.minDialect" class="select">
                  <option value="SMB2_02">SMB 2.02</option>
                  <option value="SMB2_10">SMB 2.10</option>
                  <option value="SMB3_00">SMB 3.00</option>
                  <option value="SMB3_11">SMB 3.11</option>
                </select>
              </div>
              <div class="hint" style="margin-bottom: 10px">不支持 SMB1，也不会协商降级到 SMB1。</div>
            </template>

            <div class="field">
              <label>超时（毫秒）</label>
              <input v-model.number="opts.timeoutMs" class="input" type="number" placeholder="30000" />
            </div>
            <div v-if="error" class="error">{{ error }}</div>
            <div class="modal-footer">
              <button class="btn" type="button" @click="closeDialog">取消</button>
              <button class="btn primary" type="submit" :disabled="busy">
                {{ busy ? '保存中…' : '保存连接' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </Teleport>
</template>
