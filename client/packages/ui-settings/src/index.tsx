import { useCallback, useEffect, useState } from 'react'
import { useT, type LocaleKey } from '@tianshu/locale'
import type { SidecarClient, ApprovalConfig, DefaultModelConfig, DomainConfig, ProviderConfigList } from '@tianshu/client-core'

export interface SettingsPanelProps {
  api: SidecarClient
  onClose: () => void
}

/**
 * Approval modes as permission sets (Roo's "Mode = 权限集" framing, plan §2.3): the
 * label says what stops asking, not just the mode name. Vocabulary is the contract's
 * ApprovalMode (protocol.ts:71) — a session may override it, this is the default.
 * Only the two display strings are localized; `value` is wire data.
 */
const APPROVAL_MODES: Array<{ value: string; nameKey: LocaleKey; grantsKey: LocaleKey }> = [
  { value: 'auto-accept', nameKey: 'settings.modeAutoAccept', grantsKey: 'settings.modeAutoAcceptGrants' },
  { value: 'auto-safe', nameKey: 'settings.modeAutoSafe', grantsKey: 'settings.modeAutoSafeGrants' },
  { value: 'manual', nameKey: 'settings.modeManual', grantsKey: 'settings.modeManualGrants' },
  { value: 'dangerously-skip-permissions', nameKey: 'settings.modeSkip', grantsKey: 'settings.modeSkipGrants' },
]

/** Kept as key + raw message so an on-screen error re-renders when the language flips. */
type Failure = { key: LocaleKey; message: string }

export function SettingsPanel({ api, onClose }: SettingsPanelProps) {
  const t = useT()
  const [approval, setApproval] = useState<ApprovalConfig | null>(null)
  const [model, setModel] = useState<DefaultModelConfig | null>(null)
  const [providers, setProviders] = useState<ProviderConfigList | null>(null)
  const [domains, setDomains] = useState<DomainConfig | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    void Promise.all([
      api.getApprovalConfig(),
      api.getDefaultModelConfig(),
      api.getProviders(),
      api.getDomainConfig(),
    ]).then(([a, m, p, d]) => {
      setApproval(a); setModel(m); setProviders(p); setDomains(d)
    }).catch((e: Error) => setError({ key: 'settings.readFailed', message: e.message }))
  }, [api])

  useEffect(reload, [reload])

  const applyApproval = async (value: string): Promise<void> => {
    if (!approval) return
    setBusy(true); setError(null)
    try {
      setApproval(await api.setApprovalConfig({ approval: value, ...(approval.unsandboxed !== undefined ? { unsandboxed: approval.unsandboxed } : {}) }))
    } catch (e) {
      setError({ key: 'settings.approvalFailed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const applyModel = async (ref: string): Promise<void> => {
    setBusy(true); setError(null)
    try {
      setModel(await api.setDefaultModelConfig(ref))
    } catch (e) {
      setError({ key: 'settings.modelFailed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const makeDefaultProvider = async (name: string): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await api.setDefaultProvider(name)
      reload()
    } catch (e) {
      setError({ key: 'settings.setDefaultFailed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="set">
      <header className="set__head">
        <h3>{t('settings.title')}</h3>
        <button className="set__close" onClick={onClose}>✕</button>
      </header>
      {error && <div className="set__error">{t(error.key, { message: error.message })}</div>}

      <section className="set__block">
        <h4>{t('settings.approval')}</h4>
        {APPROVAL_MODES.map((m) => (
          <label key={m.value} className={`set__mode${approval?.approval === m.value ? ' set__mode--on' : ''}`}>
            <input
              type="radio"
              name="approval"
              disabled={busy}
              checked={approval?.approval === m.value}
              onChange={() => void applyApproval(m.value)}
            />
            <span className="set__mode-name">{t(m.nameKey)}</span>
            <span className="set__mode-grants">{t(m.grantsKey)}</span>
            <code className="set__mode-id">{m.value}</code>
          </label>
        ))}
        <p className="set__note">
          {t('settings.current', { value: approval?.approval ?? '…' })}{approval?.unsandboxed ? t('settings.unsandboxed') : ''}
        </p>
      </section>

      <section className="set__block">
        <h4>{t('settings.defaultModel')}</h4>
        <p className="set__value">{model?.defaultModel ?? t('settings.notSet')}</p>
        <select
          className="set__select"
          value={model?.defaultModel ?? ''}
          disabled={busy}
          onChange={(e) => { if (e.target.value) void applyModel(e.target.value) }}
        >
          <option value="">{t('settings.selectModel')}</option>
          {(providers?.providers ?? []).flatMap((p) =>
            p.models.map((m) => (
              <option key={`${p.name}:${m.id}`} value={`${p.name}:${m.id}`}>{p.label} · {m.id}</option>
            )))}
        </select>
        {model?.defaultEffort && <p className="set__note">{t('settings.reasoning', { value: model.defaultEffort })}</p>}
      </section>

      <section className="set__block">
        <h4>{t('settings.providers')}</h4>
        {(providers?.providers ?? []).map((p) => (
          <div key={p.name} className="set__prov">
            <div className="set__prov-head">
              <b>{p.label}</b>
              {p.isDefault && <span className="set__tag set__tag--default">{t('settings.tagDefault')}</span>}
              {p.isPreset && <span className="set__tag">{t('settings.tagPreset')}</span>}
              {!p.isDefault && <button className="set__mini" disabled={busy} onClick={() => void makeDefaultProvider(p.name)}>{t('settings.makeDefault')}</button>}
            </div>
            <div className="set__prov-line"><span>{t('settings.endpoint')}</span><code>{p.baseUrl}</code></div>
            {/* keyStatus.ref is masked by the server; there is no way — and no need —
                to read a plaintext key back into this UI. */}
            <div className="set__prov-line">
              <span>{t('settings.keyColumn')}</span>
              <code>{p.keyStatus.source}{p.keyStatus.ref ? ` · ${p.keyStatus.ref}` : ''}</code>
            </div>
            <div className="set__prov-line">
              <span>{t('settings.models')}</span>
              <code>{p.models.map((m) => m.id).join(', ') || t('settings.emptyModels')}</code>
            </div>
            {p.keys.map((k) => (
              <details key={k.id} className="set__key">
                <summary>{t('settings.keySlot', { label: k.label, source: k.keyStatus.source })}</summary>
                <KeyForm
                  disabled={busy}
                  onSave={(value) => api.setProviderKey(p.name, k.id, { apiKey: value }).then(reload)}
                />
              </details>
            ))}
          </div>
        ))}
      </section>

      <section className="set__block">
        <h4>{t('settings.domains')}</h4>
        <p className="set__value">
          {t('settings.domainDefault', { value: domains?.defaultDomain ?? '…' })}
          {domains?.domainKeywordRouting ? t('settings.keywordRouting') : ''}
        </p>
        <ul className="set__domains">
          {(domains?.domains ?? []).map((d) => <li key={d.id}><b>{d.name}</b><span>{d.motto}</span></li>)}
        </ul>
      </section>
    </div>
  )
}

/** The save outcome is a state tag, not a sentence, so it re-renders in the new language. */
type KeyOutcome = { kind: 'saved' } | { kind: 'failed'; message: string }

function KeyForm({ disabled, onSave }: { disabled: boolean; onSave: (value: string) => Promise<unknown> }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null)
  return (
    <div className="set__keyform">
      {/* type=password so a shoulder-surfing pass cannot read it off the screen. The
          value goes straight to the sidecar over the same-origin proxy; it is never
          stored in the view store or in localStorage. */}
      <input
        type="password"
        autoComplete="off"
        placeholder={t('settings.pasteKey')}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        disabled={disabled || value.trim().length === 0}
        onClick={() => {
          setOutcome(null)
          void onSave(value.trim())
            .then(() => { setValue(''); setOutcome({ kind: 'saved' }) })
            // A server-side rejection text is upstream data; it stays verbatim.
            .catch((e: Error) => setOutcome({ kind: 'failed', message: e.message }))
        }}
      >
        {t('settings.save')}
      </button>
      {outcome && <span className="set__keymsg">{outcome.kind === 'saved' ? t('settings.saved') : outcome.message}</span>}
    </div>
  )
}
