// 渲染层只拿到这几个桌面专属能力；业务数据全部通过 HTTP/WS API 获取。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { contextBridge, ipcRenderer } = require('electron') as any

contextBridge.exposeInMainWorld('tunnelDesktop', {
  isDesktop: true,
  getToken: (): Promise<string> => ipcRenderer.invoke('auth:token'),
  getAppInfo: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('app:info'),
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:select-directory'),
})
