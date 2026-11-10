import { EventEmitter } from 'node:events'
import type { WsMessage } from '../../shared/types'

/** 单一事件源：传输引擎 / 连接管理产出消息，WebSocket 服务统一广播给所有客户端。 */
export class EventHub extends EventEmitter {
  broadcast(message: WsMessage): void {
    this.emit('message', message)
  }

  subscribe(listener: (message: WsMessage) => void): () => void {
    this.on('message', listener)
    return () => this.off('message', listener)
  }
}
