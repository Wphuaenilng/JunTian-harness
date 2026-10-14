import { createRoot } from 'react-dom/client'
import { SettingsPanel } from '@tianshu/ui-settings'
import type {
  SidecarClient, ApprovalConfig, DefaultModelConfig, DomainConfig, ProviderConfigList,
} from '@tianshu/client-core'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import '@tianshu/ui-settings/styles.css'
import './styles.css'

/**
 * 设置面板探针页（第十个 vite 输入，没有任何链接指向它）。
 *
 * 存在的理由是一条覆盖面事实：设置面板由宿主挂上，但**要点「设置」才挂得起来**，所以所有看浏览器的
 * 判定历史上都没在它身上跑过——本轮刚给它接上的那道 latest-wins 闸门（`reloadGate`）也就一条浏览器
 * 证据都没有。这一页把那条闸门变成外部可观察量：
 *  1. **迟到的配置读回不许盖掉屏上现在的读数。** 面板里会再发一轮 `reload` 的是**存密钥**与**设默认
 *     提供商**那两处；改审批档 / 改默认模型只把写回响应直接 setState，**不重读**——这条是本轮现读源码
 *     读出来的：第一版探针按"点审批档会重读"设计，被自己的配对判据当场打回（`approvalReads` 只涨 1）。
 *     桩让**第二发** `getApprovalConfig` 晚 300ms 落地，并故意带回一个旧档名；页面连着存两次密钥，
 *     第二发（快）先落地、第一发（迟、带旧值）后落地——屏上留下的必须是快那一发的读数。留下旧档名就是
 *     "用户什么都没做，设置自己跳回上一档"。
 *  2. 配对判据：那两发 reload **必须真发出去过**（读回计数与写计数），否则"第二下没点成"或"根本没有
 *     并发"也能把上一条判绿。
 *  3. 在场判据：四份配置都真渲染出来了（几个区块与提供商行都在），否则这一页量的是一具空壳。
 *
 * 这里的 `api` 是只实现面板真用到的那几个方法的桩对象（props 要整个 `SidecarClient`，桩按形状断言过去）。
 * 所以这一格量的是**组件的取数时序**，不是 sidecar 的配置语义——那部分由 `accept-settings.ts` 在隔离实例上量。
 */
type Counts = { approvalReads: number; keyWrites: number }
const counts: Counts = { approvalReads: 0, keyWrites: 0 }

/** 桩里唯一的"服务器状态"；本页面不动它——两次存密钥都让读回照旧答 `manual`，只有迟到的那一发撒谎。 */
let server = 'manual'

const MODEL: DefaultModelConfig = { defaultModel: 'probe:m-one', defaultEffort: null }
const DOMAIN: DomainConfig = {
  defaultDomain: 'qiming', domainKeywordRouting: false,
  domains: [{ id: 'qiming', name: '启明', motto: '探针夹具，不是产品文案' }],
}
const PROVIDERS: ProviderConfigList = {
  providers: [{
    name: 'probe', label: 'Probe 提供商', baseUrl: 'https://example.invalid/v1', protocol: 'openai',
    isDefault: true, isPreset: false, keyStatus: { source: 'none', ref: '' },
    models: [{ id: 'm-one' }],
    keys: [{ id: 'k-1', label: '槽位一', keyStatus: { source: 'none', ref: '' }, models: [{ id: 'm-one' }] }],
  }],
}

const sleep = (ms: number): Promise<void> => new Promise((res) => { setTimeout(res, ms) })

const stub = {
  getApprovalConfig: async (): Promise<ApprovalConfig> => {
    counts.approvalReads += 1
    // 第二发（改档之后那一次 reload）晚落地、且带回来的仍是改之前的值——这正是竞态的形状。
    if (counts.approvalReads === 2) {
      await sleep(300)
      return { approval: 'auto-safe' }
    }
    return { approval: server }
  },
  getDefaultModelConfig: async (): Promise<DefaultModelConfig> => MODEL,
  getProviders: async (): Promise<ProviderConfigList> => PROVIDERS,
  getDomainConfig: async (): Promise<DomainConfig> => DOMAIN,
  setProviderKey: async (): Promise<unknown> => {
    // 存密钥本身不改 server——它只触发一轮新的 reload，而那 reload 里第二发在撒谎。
    counts.keyWrites += 1
    return { ok: true }
  },
  close: (): void => undefined,
} as unknown as SidecarClient

function SettingsProbe() {
  return (
    <main className="app" data-probe="settings">
      <h1>设置面板探针 · 迟到的配置读回</h1>
      <div id="probe-panel" className="app__rail-group">
        <SettingsPanel api={stub} onClose={() => undefined} />
      </div>
    </main>
  )
}

;(window as unknown as { __setProbe__: Counts }).__setProbe__ = counts

createRoot(document.getElementById('root') as HTMLElement).render(<SettingsProbe />)
