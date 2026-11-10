<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, isDesktop, type Bootstrap, type SettingsResponse } from '../api'

const props = defineProps<{ bootstrap: Bootstrap | null }>()
const emit = defineEmits<{ close: []; notify: [message: string] }>()

const settings = ref<SettingsResponse | null>(null)
const lanEnabled = ref(false)
const port = ref(8787)
const password = ref('')
const busy = ref(false)
const error = ref('')

onMounted(async () => {
  try {
    settings.value = await api.settings()
    lanEnabled.value = settings.value.lanEnabled
    port.value = settings.value.port
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

async function save(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const result = await api.saveSettings({
      lanEnabled: lanEnabled.value,
      port: Number(port.value),
      ...(password.value ? { password: password.value } : {}),
    })
    settings.value = result
    password.value = ''
    emit(
      'notify',
      result.restarted
        ? `服务已重启，若端口变化请访问 http://127.0.0.1:${result.port}`
        : '设置已保存',
    )
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => emit('notify', '已复制访问地址'),
    () => emit('notify', '复制失败，请手动选取地址'),
  )
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="panel-head">
        <h2>设置 · Web 访问</h2>
        <div class="spacer"></div>
        <button class="btn small ghost" @click="emit('close')">关闭</button>
      </div>
      <div class="panel-body">
        <div class="section-title">访问范围</div>
        <label class="check" style="margin-bottom: 12px">
          <input v-model="lanEnabled" type="checkbox" />
          允许局域网访问（默认关闭，仅监听 127.0.0.1）
        </label>
        <div class="grid-2">
          <div class="field">
            <label>服务端口</label>
            <input v-model.number="port" class="input" type="number" min="1024" max="65535" />
          </div>
          <div class="field">
            <label>Web 访问密码{{ settings?.passwordSet ? '（已设置，留空不修改）' : '' }}</label>
            <input v-model="password" class="input" type="password" autocomplete="new-password" placeholder="至少 8 位" />
          </div>
        </div>
        <div class="hint" style="margin-bottom: 12px">
          开启局域网访问前必须先设置密码。本机桌面客户端用一次性 token 免登录；
          外部访问需密码登录，WebSocket 同样校验，连续失败会临时锁定。
        </div>
        <div v-if="error" class="error">{{ error }}</div>
        <button class="btn primary" :disabled="busy" @click="save">保存并应用</button>

        <div class="divider"></div>
        <div class="section-title">手机访问地址</div>
        <div v-if="lanEnabled && settings?.lanAddresses?.length" class="list">
          <div v-for="ip in settings.lanAddresses" :key="ip" class="row">
            <span class="grow"><code>http://{{ ip }}:{{ port }}</code></span>
            <button class="btn small" @click="copy(`http://${ip}:${port}`)">复制</button>
          </div>
        </div>
        <div v-else class="hint">
          局域网访问当前关闭。开启后这里会列出可访问地址，手机与桌面需在同一网络。
        </div>

        <div class="divider"></div>
        <div class="hint">
          · 桌面端必须保持运行（可最小化到托盘），手机才能访问。<br />
          · 不做公网映射 / UPnP / 中继，仅限可信局域网。<br />
          · 首次开启时 Windows 防火墙或 macOS 可能弹出「允许传入连接」提示。<br />
          · 凭据存储：{{ bootstrap?.credentialStore ?? '—' }}<br />
          · 数据目录：{{ bootstrap?.dataDir ?? '—' }}
        </div>
      </div>
    </div>
  </div>
</template>
