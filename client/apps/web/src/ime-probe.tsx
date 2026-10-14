import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { submitsOnEnter } from '@tianshu/ui-primitives'
import '@tianshu/ui-theme/tokens.css'
import './styles.css'

/**
 * IME 探针页（第八个 vite 输入，没有任何链接指向它）。
 *
 * 为什么需要它：`submitsOnEnter` 的真值表有单测、宿主那一处调用点有 `check:layers` 钉着，但**这两件
 * 都是源码级的**。这一页把那条链在真 Chromium 里量一次：与 composer 同形状的 controlled textarea
 * （`value` + `onChange` + `onKeyDown`，判定用同一份谓词、同一个调用形状），页面把每次按下的
 * `key / shiftKey / 合成事件的 isComposing / 原生事件的 isComposing` 和"这一次有没有发送"记下来。
 *
 * 就是这一条把修复本身的错抓出来的：React 18.3.1 的合成键盘事件**不带** `isComposing`
 * （`@types/react@18.3.31` 的 `KeyboardEvent` 接口里没有那个字段，react-dom 按同一份接口造合成事件），
 * 所以 `e.isComposing` 在真事件路径里是 `undefined` —— 照着它写的守卫等于没写。这一页读的是
 * `nativeEvent.isComposing`，并把两个值都记下来，"合成 undefined / 原生 true"这件事从此有读数。
 *
 * 这里**不**证明的：真实操作系统输入法产生的事件序列（无人值守造不出那一级），以及真产品页上那个
 * composer（它要一台有会话的实例，属付费那一格的邻居）。
 */
type KeyPress = {
  key: string
  shiftKey: boolean
  /** React 合成事件上的那个标志——18.3.1 上是 undefined，这里记成 null 以便判定点名它。 */
  composing: boolean | null
  nativeComposing: boolean
  sent: boolean
  bufferAtPress: string
}

const probe: { presses: KeyPress[] } = { presses: [] }
;(window as unknown as { __imeProbe__: typeof probe }).__imeProbe__ = probe

function ImeProbe() {
  const [buffer, setBuffer] = useState('')

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const synthetic = (e as unknown as { isComposing?: boolean }).isComposing
    // 与 apps/web/src/App.tsx 那一处**同一个调用形状**：标志取原生事件。
    const sent = submitsOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })
    probe.presses.push({
      key: e.key,
      shiftKey: e.shiftKey,
      composing: synthetic === undefined ? null : synthetic,
      nativeComposing: e.nativeEvent.isComposing,
      sent,
      bufferAtPress: e.currentTarget.value,
    })
    if (sent) setBuffer('')
  }

  return (
    <main className="app" data-probe="ime">
      <h1>IME 探针 · Enter 提交规则</h1>
      <div className="app__input-row">
        <textarea
          id="ime-box"
          value={buffer}
          onChange={(e) => { setBuffer(e.target.value) }}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="输入中文，按 Enter 上屏候选词"
        />
        <button className="app__send" aria-label="发送" onClick={() => { setBuffer('') }}>➤</button>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<ImeProbe />)
