// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAppConfig } from '../lib/config';
import type { BuildInfo } from '../lib/config';
import { getCsrfToken } from '../lib/csrf';
import type { LoggingStatus } from '../api/types';
import { useApi } from '../hooks/useApi';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../hooks/useTranslation';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import { useToast } from '../components/shared/Toast';
import type { ApprovedProvider, ProviderConfigResponse, ActivityEvent } from '../api/types';
import { StartOverModal } from '../components/overlay/StartOverModal';
import { LanguageSelector } from '../components/shared/LanguageSelector';
import { GUI_ERRORS, formatGuiError } from '../i18n/gui-errors';


interface ProviderCardProps {
  provider:  ApprovedProvider;
  selected:  boolean;
  onClick:   () => void;
}

function ProviderCard({ provider, selected, onClick }: ProviderCardProps) {
  const { t } = useTranslation();
  const isFree = provider.tier === 'free';
  const qualityColor = provider.quality.startsWith('A') ? 'var(--color-success)' : 'var(--color-accent)';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        background:   selected ? 'var(--color-accent-muted)' : 'var(--color-bg)',
        border:       `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-md)',
        padding:      '12px 14px',
        cursor:       'pointer',
        display:      'flex',
        alignItems:   'flex-start',
        gap:          '10px',
        transition:   'border-color 0.15s ease, background 0.15s ease',
        position:     'relative',
        userSelect:   'none',
      }}
    >
      {/* Checkmark */}
      {selected && (
        <div style={{
          position:     'absolute',
          top:          '8px',
          right:        '10px',
          color:        'var(--color-accent)',
          fontWeight:   700,
          fontSize:     '16px',
        }}>
          ✓
        </div>
      )}

      {/* Radio indicator */}
      <div style={{
        width:        '16px',
        height:       '16px',
        borderRadius: '50%',
        border:       `2px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        flexShrink:   0,
        marginTop:    '2px',
        background:   selected ? 'var(--color-accent)' : 'transparent',
        boxSizing:    'border-box',
      }} />

      <div className="page-settings--provider-content">
        <div className="page-settings--provider-name-row">
          <span className="page-settings--provider-name">
            {provider.display_name}
          </span>
          {provider.recommended && (
            <span className="page-settings--provider-rec-badge">
              {t('gui.settings.provider.recommended_badge')}
            </span>
          )}
        </div>

        <div className="page-settings--provider-meta">
          {isFree ? (
            <span className="page-settings--provider-free-badge">
              {t('gui.settings.provider.free_badge')}
            </span>
          ) : (
            <span className="page-settings--provider-tier">
              ${provider.input_price}/${provider.output_price} per 1M
            </span>
          )}

          <span style={{
            fontSize:   '14px',
            fontWeight: 700,
            color:      qualityColor,
            padding:    '1px 5px',
            border:     `1px solid ${qualityColor}`,
            borderRadius: '4px',
          }}>
            {provider.quality}
          </span>

          {isFree && provider.rate_limit !== 'none' && (
            <span className="page-settings--provider-rate">
              {provider.rate_limit}
            </span>
          )}
        </div>

        <p className="page-settings--provider-hint">
          {provider.info}
        </p>
      </div>
    </div>
  );
}


interface ApiKeySectionProps {
  provider:    ApprovedProvider | null;
  isCustom:    boolean;
  onSaved:     () => void;
}

function ApiKeySection({ provider, isCustom, onSaved }: ApiKeySectionProps) {
  const { client }     = useAppConfig();
  const { t }          = useTranslation();
  const toast          = useToast();

  const [apiKey,       setApiKey]       = useState('');
  const [showKey,      setShowKey]      = useState(false);
  const [testing,      setTesting]      = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [testStatus,   setTestStatus]   = useState<'idle' | 'ok' | 'error'>('idle');
  const [testMessage,  setTestMessage]  = useState('');
  const [responseMs,   setResponseMs]   = useState<number | null>(null);

  // Custom provider fields
  const [customName,   setCustomName]   = useState('');
  const [customBase,   setCustomBase]   = useState('');
  const [customModel,  setCustomModel]  = useState('');

  // Reset when provider changes
  useEffect(() => {
    setApiKey('');
    setTestStatus('idle');
    setTestMessage('');
    setResponseMs(null);
    setCustomName('');
    setCustomBase(isCustom ? '' : (provider?.api_base ?? ''));
    setCustomModel(isCustom ? '' : (provider?.model ?? ''));
  }, [provider?.id, isCustom]);

  async function handleTest() {
    if (!client || !apiKey.trim()) return;
    setTesting(true);
    setTestStatus('idle');

    try {
      const body: { provider_id?: string; api_key: string; api_base?: string; model?: string } = {
        api_key: apiKey.trim(),
      };
      if (isCustom) {
        body.api_base = customBase.trim();
        body.model    = customModel.trim();
      } else if (provider) {
        body.provider_id = provider.id;
      }

      const result = await client.testProvider(body);
      if (result.status === 'ok') {
        setTestStatus('ok');
        setTestMessage(result.message ?? 'Connection successful — AI provider is ready.');
        setResponseMs(result.response_time_ms ?? null);
      } else {
        setTestStatus('error');
        setTestMessage(result.error ?? `${GUI_ERRORS['GUI-PROVIDER-001'].message} ${GUI_ERRORS['GUI-PROVIDER-001'].suggestion}`);
      }
    } catch (err: unknown) {
      setTestStatus('error');
      setTestMessage(formatGuiError(err));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!client || testStatus !== 'ok') return;
    setSaving(true);

    try {
      await client.saveProviderConfig({
        mode:             'simple',
        default_provider: {
          provider_id: isCustom ? 'custom' : (provider?.id ?? 'custom'),
          api_key:     apiKey.trim(),
          ...(isCustom ? {
            api_base:    customBase.trim(),
            model:       customModel.trim(),
            custom_name: customName.trim() || undefined,
          } : {
            api_base: provider?.api_base,
            model:    provider?.model,
          }),
        },
        agent_overrides: {},
      });
      toast.success('Provider configured — your agents are now ready.');
      onSaved();
    } catch (err: unknown) {
      toast.error(formatGuiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-settings--key-section">
      <div className="page-settings--key-section-header">
        <h3 className="page-settings--key-section-title">
          {isCustom ? t('gui.settings.provider.custom_setup') : provider?.display_name}
        </h3>
        {!isCustom && provider && (
          <a
            href={provider.signup_url}
            target="_blank"
            rel="noopener noreferrer"
            className="page-settings--signup-link"
          >
            {t('gui.settings.provider.sign_up')}
          </a>
        )}
      </div>

      {/* Custom fields */}
      {isCustom && (
        <>
          <label className="page-settings--label">
            {t('gui.settings.provider.name')}
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={t('gui.settings.provider.custom_name_example')}
              className="page-settings--input"
            />
          </label>
          <label className="page-settings--label">
            {t('gui.settings.provider.api_base')}
            <input
              type="url"
              value={customBase}
              onChange={(e) => setCustomBase(e.target.value)}
              placeholder={t('gui.settings.provider.api_base_example')}
              className="page-settings--input"
              spellCheck={false}
            />
          </label>
          <label className="page-settings--label">
            {t('gui.settings.provider.model')}
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder={t('gui.settings.provider.model_example')}
              className="page-settings--input"
              spellCheck={false}
            />
          </label>
        </>
      )}

      {/* API key input */}
      <label className="page-settings--label">
        {t('gui.settings.provider.api_key')}{' '}
        {isCustom && <span style={{ fontWeight: 400 }}>{t('gui.settings.provider.api_key_optional')}</span>}
        <div style={{ position: 'relative' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setTestStatus('idle'); }}
            placeholder={isCustom ? t('gui.settings.provider.key_placeholder_local') : t('gui.settings.provider.key_placeholder_cloud')}
            className="page-settings--input"
            style={{ paddingRight: '40px' }}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? t('gui.settings.provider.hide_key') : t('gui.settings.provider.show_key')}
            style={{
              position:   'absolute',
              right:      '8px',
              top:        '50%',
              transform:  'translateY(-50%)',
              background: 'none',
              border:     'none',
              cursor:     'pointer',
              color:      'var(--color-text-muted)',
              fontSize:   '16px',
              padding:    '2px 4px',
            }}
          >
            {showKey ? '🙈' : '👁'}
          </button>
        </div>
      </label>

      {/* Test result */}
      {testStatus === 'ok' && (
        <div className="page-settings--test-ok">
          ✅ {testMessage}{responseMs !== null ? ` ${t('gui.settings.provider.response_time', { ms: String(responseMs) })}` : ''}
        </div>
      )}
      {testStatus === 'error' && (
        <div className="page-settings--error-msg">
          ❌ {testMessage}
        </div>
      )}

      {/* Buttons */}
      <div className="page-settings--btn-row">
        <button
          onClick={() => { void handleTest(); }}
          disabled={testing || (!apiKey.trim() && !isCustom)}
          className="page-settings--secondary-btn"
        >
          {testing ? <LoadingSpinner size="sm" label={t('gui.settings.provider.testing')} /> : t('gui.settings.provider.test')}
        </button>
        <button
          onClick={() => { void handleSave(); }}
          disabled={saving || testStatus !== 'ok'}
          style={primaryButtonStyle(saving || testStatus !== 'ok')}
        >
          {saving ? <LoadingSpinner size="sm" label={t('gui.settings.provider.saving')} /> : t('gui.settings.provider.save_activate')}
        </button>
      </div>
    </div>
  );
}


interface AdvancedModeProps {
  catalog:  ApprovedProvider[];
  config:   ProviderConfigResponse | null;
  onSaved:  () => void;
}

function AdvancedMode({ catalog, config, onSaved }: AdvancedModeProps) {
  const { client } = useAppConfig();
  const { t }      = useTranslation();
  const toast      = useToast();

  const AGENT_IDS = ['guide', 'hr', 'it', 'auditor', 'finance', 'librarian'];

  const allOptions = [
    ...catalog.map((p) => ({ value: p.id, label: p.display_name })),
    { value: 'custom', label: t('gui.settings.provider.custom_label') },
  ];

  // Default each agent to the current default provider (explicit, never "Wie Standard")
  const defaultProviderId = config?.default_provider?.provider_id ?? (catalog[0]?.id ?? 'custom');

  const [overrides, setOverrides] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const id of AGENT_IDS) init[id] = defaultProviderId;
    return init;
  });

  async function handleSave() {
    if (!client) return;

    // Warn if any agent is assigned to a provider different from the default
    const defaultPid = config?.default_provider?.provider_id;
    const hasMismatch = Object.values(overrides).some((provId) => provId !== defaultPid);
    if (hasMismatch) {
      const confirmed = window.confirm(
        'Warning: Some agents are assigned to providers different from your default. ' +
        'These agents will use the default provider\'s API key, which may not work if the providers require separate keys. ' +
        'Ensure the selected providers accept the same API key, or configure each agent separately.\n\nSave anyway?'
      );
      if (!confirmed) return;
    }

    const agentOverrides: Record<string, { provider_id: string; api_key: string; api_base?: string }> = {};
    for (const [agentId, provId] of Object.entries(overrides)) {
      const entry = catalog.find((p) => p.id === provId);
      if (!entry) continue;
      agentOverrides[agentId] = {
        provider_id: provId,
        api_key:     config?.default_provider?.api_key_preview ?? '',
        api_base:    entry.api_base,
      };
    }
    try {
      await client.saveProviderConfig({
        mode:             'advanced',
        default_provider: config?.default_provider !== null && config?.default_provider !== undefined ? {
          provider_id: config.default_provider.provider_id,
          api_key:     '',
        } : null,
        agent_overrides:  agentOverrides,
      });
      toast.success('Agent overrides saved.');
      onSaved();
    } catch (err: unknown) {
      toast.error(formatGuiError(err));
    }
  }

  return (
    <div className="page-settings--advanced-list">
      <p className="page-settings--helper-text">
        {t('gui.settings.provider.advanced_desc')}
      </p>
      {AGENT_IDS.map((agentId) => (
        <div key={agentId} className="page-settings--agent-row">
          <span className="page-settings--agent-label">
            {agentId}
          </span>
          <select
            value={overrides[agentId] ?? 'default'}
            onChange={(e) => setOverrides((prev) => ({ ...prev, [agentId]: e.target.value }))}
            className="page-settings--select"
            style={{ flex: 1 }}
          >
            {allOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      ))}
      <button
        onClick={() => { void handleSave(); }}
        style={{ ...primaryButtonStyle(false), alignSelf: 'flex-start', marginTop: '8px' }}
      >
        {t('gui.settings.provider.save_overrides')}
      </button>

      {/* HR agent hint */}
      <p className="page-settings--note">
        {t('gui.settings.agents.hr_hint')}
      </p>
    </div>
  );
}


interface ProviderSettingsProps {
  onConfigChange: () => void;
}

function ProviderSettings({ onConfigChange }: ProviderSettingsProps) {
  const { client }       = useAppConfig();
  const { t }            = useTranslation();
  const toast            = useToast();

  const [catalog,        setCatalog]       = useState<ApprovedProvider[] | null>(null);
  const [currentConfig,  setCurrentConfig] = useState<ProviderConfigResponse | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  const [mode,           setMode]          = useState<'simple' | 'advanced'>('simple');
  const [selectedId,     setSelectedId]    = useState<string | null>(null);
  const [showCustom,     setShowCustom]    = useState(false);

  const loadData = useCallback(async () => {
    if (!client) return;
    setLoadingCatalog(true);
    try {
      const [cat, cfg] = await Promise.all([
        client.getProviderCatalog(),
        client.getProviderConfig(),
      ]);
      setCatalog(cat.providers);
      setCurrentConfig(cfg);
      if (cfg.configured && cfg.default_provider) {
        setSelectedId(cfg.default_provider.provider_id);
        setMode(cfg.mode);
      }
    } catch (err: unknown) {
      toast.error(formatGuiError(err));
    } finally {
      setLoadingCatalog(false);
    }
  }, [client, toast]);

  useEffect(() => { void loadData(); }, [loadData]);

  async function handleReset() {
    if (!client) return;
    try {
      await client.deleteProviderConfig();
      setCurrentConfig(null);
      setSelectedId(null);
      toast.success('Provider configuration cleared.');
      onConfigChange();
    } catch (err: unknown) {
      toast.error(formatGuiError(err));
    }
  }

  if (!client) {
    return (
      <div className="sidjua-text-muted-sm">
        {t('gui.settings.llm_provider_connect_first')}
      </div>
    );
  }

  if (loadingCatalog) {
    return <LoadingSpinner label={t('gui.settings.llm_provider_loading')} />;
  }

  if (!catalog) return null;

  const freeProviders = catalog.filter((p) => p.tier === 'free');
  const paidProviders = catalog.filter((p) => p.tier === 'paid');

  const selectedProvider = catalog.find((p) => p.id === selectedId) ?? null;

  return (
    <div>
      {/* Current config banner */}
      {currentConfig?.configured && currentConfig.default_provider && (
        <div className="page-settings--config-banner">
          <span className="page-settings--config-status">
            ✅ {currentConfig.default_provider.display_name} — {currentConfig.default_provider.api_key_preview}
          </span>
          <button
            onClick={() => { void handleReset(); }}
            className="page-settings--change-btn"
          >
            {t('gui.settings.provider.change')}
          </button>
        </div>
      )}

      {/* Mode toggle */}
      <div className="page-settings--mode-toggle-row">
        <span className="page-settings--period-label">
          {t('gui.settings.provider.mode_label')}
        </span>
        {(['simple', 'advanced'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding:      '5px 14px',
              borderRadius: 'var(--radius-md)',
              border:       '1px solid',
              borderColor:  mode === m ? 'var(--color-accent)' : 'var(--color-border)',
              background:   mode === m ? 'var(--color-accent-muted)' : 'var(--color-surface)',
              color:        mode === m ? 'var(--color-accent)' : 'var(--color-text)',
              fontWeight:   mode === m ? 600 : 400,
              cursor:       'pointer',
              fontSize:     '15px',
            }}
          >
            {m === 'simple' ? t('gui.settings.provider.mode_simple') : t('gui.settings.provider.mode_advanced')}
          </button>
        ))}
      </div>

      {/* Advanced mode */}
      {mode === 'advanced' && (
        <AdvancedMode catalog={catalog} config={currentConfig} onSaved={() => { void loadData(); onConfigChange(); }} />
      )}

      {/* Simple mode: provider cards with inline accordion */}
      {mode === 'simple' && (
        <>
          {/* Free providers */}
          <div className="page-settings--divider">{t('gui.settings.provider.free_providers')}</div>
          <div className="page-settings--provider-list">
            {freeProviders.map((p) => (
              <div key={p.id}>
                <ProviderCard
                  provider={p}
                  selected={selectedId === p.id && !showCustom}
                  onClick={() => {
                    setSelectedId((prev) => prev === p.id ? null : p.id);
                    setShowCustom(false);
                  }}
                />
                {selectedId === p.id && !showCustom && (
                  <div style={{ marginTop: '2px' }}>
                    <ApiKeySection
                      provider={p}
                      isCustom={false}
                      onSaved={() => { void loadData(); onConfigChange(); }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Paid providers */}
          <div className="page-settings--divider">{t('gui.settings.provider.paid_providers')}</div>
          <div className="page-settings--provider-list">
            {paidProviders.map((p) => (
              <div key={p.id}>
                <ProviderCard
                  provider={p}
                  selected={selectedId === p.id && !showCustom}
                  onClick={() => {
                    setSelectedId((prev) => prev === p.id ? null : p.id);
                    setShowCustom(false);
                  }}
                />
                {selectedId === p.id && !showCustom && (
                  <div style={{ marginTop: '2px' }}>
                    <ApiKeySection
                      provider={p}
                      isCustom={false}
                      onSaved={() => { void loadData(); onConfigChange(); }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Custom provider */}
          <div className="page-settings--divider">{t('gui.settings.provider.custom_provider')}</div>
          <div style={{ marginBottom: '16px' }}>
            <button
              onClick={() => { setShowCustom((v) => !v); setSelectedId(null); }}
              className="page-settings--secondary-btn"
              style={{
                background:  showCustom ? 'var(--color-accent-muted)' : undefined,
                borderColor: showCustom ? 'var(--color-accent)' : undefined,
                color:       showCustom ? 'var(--color-accent)' : undefined,
              }}
            >
              {showCustom ? '▼' : '▶'} {showCustom ? t('gui.settings.provider.custom_label') : t('gui.settings.provider.add_custom')}
            </button>
            {!showCustom && (
              <p className="page-settings--provider-hint">
                {t('gui.settings.provider.ollama_hint')}
              </p>
            )}
            {showCustom && (
              <div style={{ marginTop: '2px' }}>
                <ApiKeySection
                  provider={null}
                  isCustom={true}
                  onSaved={() => { void loadData(); onConfigChange(); }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}


function SettingsHelpPanel() {
  const { t } = useTranslation();

  const helpSections = [
    { key: 'server_connection', label: t('gui.settings.server_connection') },
    { key: 'llm_provider',      label: t('gui.settings.llm_provider') },
    { key: 'workspace',         label: t('gui.settings.workspace') },
    { key: 'language',          label: t('gui.settings.language') },
    { key: 'appearance',        label: t('gui.settings.appearance') },
  ] as const;

  return (
    <aside className="page-settings--help-aside">
      {/* Getting Started */}
      <div className="sidjua-card">
        <h3 className="page-settings--help-heading">{t('gui.settings.help.getting_started')}</h3>

        {/* Login / setup callout */}
        <div className="page-settings--api-callout">
          <div className="page-settings--callout-heading">
            {t('gui.settings.help.where_apikey')}
          </div>
          <div className="page-settings--callout-code">
            {t('gui.settings.help.apikey_command')}
          </div>
          <div className="page-settings--callout-note">
            {t('gui.settings.help.container_note')}
          </div>
        </div>

        <div className="page-settings--help-body">
          {t('gui.settings.help.getting_started_body').split('\n').map((line, i) => (
            line.trim() === '' ? <br key={i} /> : (
              <p key={i} style={{
                margin: 0,
                fontFamily: line.startsWith('   ') ? 'monospace' : undefined,
                fontSize:   line.startsWith('   ') ? '11px' : undefined,
                background: line.startsWith('   ') ? 'var(--color-bg)' : undefined,
                padding:    line.startsWith('   ') ? '2px 6px' : undefined,
                borderRadius: line.startsWith('   ') ? '3px' : undefined,
                color:      line.startsWith('   ') ? 'var(--color-text)' : undefined,
              }}>
                {line.trim()}
              </p>
            )
          ))}
        </div>
      </div>

      {/* About Settings */}
      <div className="sidjua-card">
        <h3 className="page-settings--help-heading">{t('gui.settings.help.about_settings')}</h3>
        <div className="page-settings--help-sections">
          {helpSections.map(({ key, label }) => (
            <div key={key}>
              <div className="page-settings--help-section-label">
                {label}
              </div>
              <div className="page-settings--help-section-text">
                {t(`gui.settings.help.${key}`)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}


export function Settings() {
  const { client, buildInfo } = useAppConfig();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const toast = useToast();

  const [providerKey,   setProviderKey]   = useState(0); // force re-render on provider save
  const [showStartOver, setShowStartOver] = useState(false);
  const [backupBusy,    setBackupBusy]    = useState(false);

  // Password change (P434c)
  const [currentPw,  setCurrentPw]  = useState('');
  const [newPw,      setNewPw]      = useState('');
  const [confirmPw,  setConfirmPw]  = useState('');
  const [pwBusy,     setPwBusy]     = useState(false);
  const [pwError,    setPwError]    = useState<string | null>(null);

  // Error logging toggle
  const loggingRes = useApi<LoggingStatus>((c) => c.loggingStatus());
  const [errorLogging,       setErrorLogging]       = useState<boolean | null>(null);
  const [errorLoggingBusy,   setErrorLoggingBusy]   = useState(false);
  const [errorLoggingError,  setErrorLoggingError]  = useState<string | null>(null);
  const errorLoggingInitRef = useRef(false);
  const [recentErrors,       setRecentErrors]       = useState<ActivityEvent[] | null>(null);
  const [errorsLoading,      setErrorsLoading]      = useState(false);

  // Bouncer (security) settings
  const [bouncerEnabled,     setBouncerEnabled]     = useState<boolean | null>(null);
  const [bouncerSensitivity, setBouncerSensitivity] = useState<'strict' | 'normal' | 'relaxed'>('normal');
  const [bouncerBusy,        setBouncerBusy]        = useState(false);
  const [bouncerError,       setBouncerError]       = useState<string | null>(null);
  const bouncerInitRef = useRef(false);

  useEffect(() => {
    if (loggingRes.data?.errorLogging !== undefined && !errorLoggingInitRef.current) {
      setErrorLogging(loggingRes.data.errorLogging);
      errorLoggingInitRef.current = true;
    }
  }, [loggingRes.data]);

  async function handleErrorLoggingToggle(): Promise<void> {
    if (!client || errorLogging === null || errorLoggingBusy) return;
    const next = !errorLogging;
    setErrorLogging(next);          // optimistic
    setErrorLoggingBusy(true);
    setErrorLoggingError(null);
    try {
      await client.setErrorLogging(next);
    } catch (err: unknown) {
      setErrorLogging(!next);       // revert on failure
      setErrorLoggingError(formatGuiError(err));
    } finally {
      setErrorLoggingBusy(false);
    }
  }

  async function loadRecentErrors(): Promise<void> {
    if (!client || errorsLoading) return;
    setErrorsLoading(true);
    try {
      const res = await client.listErrorEvents(20);
      setRecentErrors(res.events);
    } catch (_err) {
      setRecentErrors([]);
    } finally {
      setErrorsLoading(false);
    }
  }

  useEffect(() => {
    if (client && recentErrors === null) { void loadRecentErrors(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Load bouncer config on mount
  useEffect(() => {
    if (!client || bouncerInitRef.current) return;
    bouncerInitRef.current = true;
    void (async () => {
      try {
        const cfg = await client.getBouncerConfig();
        setBouncerEnabled(cfg.enabled);
        setBouncerSensitivity(cfg.sensitivity);
      } catch (_err: unknown) {
        // Non-fatal — defaults remain
        setBouncerEnabled(true);
      }
    })();
  }, [client]);

  async function handleBouncerToggle(): Promise<void> {
    if (!client || bouncerEnabled === null || bouncerBusy) return;
    const next = !bouncerEnabled;
    setBouncerEnabled(next);        // optimistic
    setBouncerBusy(true);
    setBouncerError(null);
    try {
      await client.setBouncerConfig({ enabled: next });
    } catch (err: unknown) {
      setBouncerEnabled(!next);     // revert
      setBouncerError(formatGuiError(err));
    } finally {
      setBouncerBusy(false);
    }
  }

  async function handleBouncerSensitivity(value: 'strict' | 'normal' | 'relaxed'): Promise<void> {
    if (!client || bouncerBusy) return;
    const prev = bouncerSensitivity;
    setBouncerSensitivity(value);   // optimistic
    setBouncerBusy(true);
    setBouncerError(null);
    try {
      await client.setBouncerConfig({ sensitivity: value });
    } catch (err: unknown) {
      setBouncerSensitivity(prev);  // revert
      setBouncerError(formatGuiError(err));
    } finally {
      setBouncerBusy(false);
    }
  }

  // ── Language management (installed languages) ────────────────────────────
  const [installedLangs,    setInstalledLangs]    = useState<string[] | null>(null);
  const [availableLangs,    setAvailableLangs]    = useState<string[]>([]);
  const [activeLang,        setActiveLang]        = useState<string>('en');
  const [langBusy,          setLangBusy]          = useState(false);
  const [langError,         setLangError]         = useState<string | null>(null);
  const [addLangCode,       setAddLangCode]       = useState<string>('');
  const langInitRef = useRef(false);

  useEffect(() => {
    if (!client || langInitRef.current) return;
    langInitRef.current = true;
    void (async () => {
      try {
        const [installed, meta] = await Promise.all([
          client.get<{ languages: string[]; active: string }>('/api/v1/locale/installed'),
          client.get<{ available: string[] }>('/api/v1/locale'),
        ]);
        setInstalledLangs(installed.languages);
        setActiveLang(installed.active);
        setAvailableLangs(meta.available ?? []);
      } catch (_err) {
        // Non-fatal — section stays hidden
      }
    })();
  }, [client]);

  async function handleInstallLang(code: string): Promise<void> {
    if (!client || langBusy || !code) return;
    setLangBusy(true);
    setLangError(null);
    try {
      const res = await client.post<{ languages: string[] }>('/api/v1/locale/install', { code });
      setInstalledLangs(res.languages);
      setAddLangCode('');
    } catch (err: unknown) {
      setLangError(formatGuiError(err));
    } finally {
      setLangBusy(false);
    }
  }

  async function handleUninstallLang(code: string): Promise<void> {
    if (!client || langBusy) return;
    setLangBusy(true);
    setLangError(null);
    try {
      const res = await client.post<{ languages: string[] }>('/api/v1/locale/uninstall', { code });
      setInstalledLangs(res.languages);
    } catch (err: unknown) {
      setLangError(formatGuiError(err));
    } finally {
      setLangBusy(false);
    }
  }

  async function handleBackup(): Promise<void> {
    if (!client || backupBusy) return;
    setBackupBusy(true);
    try {
      const result = await client.createBackup();
      toast.success(t('gui.settings.workspace_backup_success', { path: result.path }));
    } catch (err: unknown) {
      toast.error(formatGuiError(err));
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleChangePassword(): Promise<void> {
    setPwError(null);
    if (newPw.length < 12) { setPwError('New password must be at least 12 characters.'); return; }
    if (newPw !== confirmPw) { setPwError('Passwords do not match.'); return; }
    if (!client) return;
    setPwBusy(true);
    try {
      await client.changePassword(currentPw, newPw);
      toast.success('Password changed successfully.');
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err: unknown) {
      setPwError(formatGuiError(err));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="page-settings--layout">
      {/* ── Left column: settings cards ── */}
      <div>
        {/* Admin Password (P434c) */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.admin_password_header')}</h2>

          <label className="page-settings--label">
            {t('gui.settings.current_password')}
            <input
              type="password"
              value={currentPw}
              onChange={(e) => setCurrentPw(e.target.value)}
              placeholder={t('gui.settings.current_password')}
              className="page-settings--input"
              autoComplete="current-password"
              spellCheck={false}
            />
          </label>

          <label className="page-settings--label">
            {t('gui.settings.new_password')}
            <input
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder={t('gui.settings.new_password_hint')}
              className="page-settings--input"
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>

          <label className="page-settings--label">
            {t('gui.settings.confirm_new_password')}
            <input
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder={t('gui.settings.confirm_new_password_hint')}
              className="page-settings--input"
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>

          {pwError && (
            <p className="page-settings--error-msg-sm">{pwError}</p>
          )}

          <div className="page-settings--btn-row">
            <button
              onClick={() => { void handleChangePassword(); }}
              disabled={pwBusy || !currentPw || !newPw || !confirmPw}
              style={primaryButtonStyle(pwBusy || !currentPw || !newPw || !confirmPw)}
            >
              {pwBusy ? <LoadingSpinner size="sm" label="Saving…" /> : t('gui.settings.change_password_button')}
            </button>
          </div>
        </section>

        {/* LLM Provider */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.llm_provider')}</h2>
          <p style={{ fontSize: '15px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
            {t('gui.settings.llm_provider_desc')}
          </p>
          <ProviderSettings key={providerKey} onConfigChange={() => setProviderKey((k) => k + 1)} />
        </section>

        {/* Workspace */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.workspace')}</h2>

          {/* Backup guidance */}
          <p style={{ fontSize: '15px', color: 'var(--color-text-secondary)', marginBottom: '16px', lineHeight: 1.6 }}>
            {t('gui.settings.workspace_backup_hint')}
          </p>
          <div className="page-settings--workspace-actions">
            <button
              onClick={() => { void handleBackup(); }}
              disabled={backupBusy || !client}
              className="page-settings--ws-btn-primary"
            >
              {backupBusy ? t('gui.settings.workspace_backup_running') : t('gui.settings.workspace_backup_button')}
            </button>
            <button
              disabled
              title={t('gui.settings.workspace_coming_soon')}
              className="page-settings--ws-btn-secondary"
            >
              {t('gui.settings.workspace_restore_button')}
            </button>
          </div>

          {/* Separator */}
          <div className="page-settings--separator" />

          {/* Reset / Start Over */}
          <p style={{ fontSize: '15px', color: 'var(--color-text-secondary)', marginBottom: '12px', lineHeight: 1.6 }}>
            {t('gui.settings.workspace_reset_warning')}
          </p>
          <button
            onClick={() => setShowStartOver(true)}
            className="page-settings--start-over-btn"
          >
            {t('gui.settings.start_over')}
          </button>
        </section>

        {/* Language */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.language')}</h2>
          <p style={{ fontSize: '15px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
            {t('gui.settings.language_desc')}
          </p>
          <LanguageSelector />
        </section>

        {/* Languages management (installed list) */}
        {installedLangs !== null && (
          <section className="page-settings--section">
            <h2 className="page-settings--section-h2">{t('gui.settings.languages_header')}</h2>
            <div className="page-settings--lang-list">
              <div className="page-settings--lang-list-header">
                {t('gui.settings.languages_installed')}
              </div>
              {installedLangs.map((code) => (
                <div key={code} className="page-settings--lang-row">
                  <span style={{ fontSize: '15px', color: 'var(--color-text)' }}>
                    {code}
                    {code === activeLang && (
                      <span className="page-settings--lang-active">
                        {t('gui.settings.languages_active')}
                      </span>
                    )}
                  </span>
                  {code !== 'en' && code !== activeLang && (
                    <button
                      onClick={() => { void handleUninstallLang(code); }}
                      disabled={langBusy}
                      title={t('gui.settings.languages_remove')}
                      style={{
                        background:   'none',
                        border:       '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                        cursor:       langBusy ? 'default' : 'pointer',
                        padding:      '2px 8px',
                        fontSize:     '13px',
                        color:        'var(--color-text-muted)',
                        opacity:      langBusy ? 0.5 : 1,
                      }}
                    >
                      {t('gui.settings.languages_remove')}
                    </button>
                  )}
                </div>
              ))}

              {/* Add language dropdown */}
              {(() => {
                const notInstalled = availableLangs.filter((c) => !installedLangs.includes(c));
                if (notInstalled.length === 0) return null;
                return (
                  <div className="page-settings--lang-add-row">
                    <select
                      value={addLangCode}
                      onChange={(e) => setAddLangCode(e.target.value)}
                      disabled={langBusy}
                      className="page-settings--select"
                      style={{ flex: 1 }}
                    >
                      <option value="">{t('gui.settings.languages_add')}…</option>
                      {notInstalled.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => { void handleInstallLang(addLangCode); }}
                      disabled={langBusy || addLangCode === ''}
                      style={{
                        padding:      '6px 14px',
                        borderRadius: 'var(--radius-sm)',
                        border:       '1px solid var(--color-accent)',
                        background:   'var(--color-accent-muted)',
                        color:        'var(--color-accent)',
                        cursor:       langBusy || addLangCode === '' ? 'default' : 'pointer',
                        fontSize:     '15px',
                        opacity:      langBusy || addLangCode === '' ? 0.5 : 1,
                      }}
                    >
                      {t('gui.settings.languages_add')}
                    </button>
                  </div>
                );
              })()}

              {langError && (
                <p className="page-settings--error-msg-sm">{langError}</p>
              )}
            </div>
          </section>
        )}

        {/* Appearance */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.appearance')}</h2>

          <div className="page-settings--theme-toggle">
            {(['light', 'dark'] as const).map((thm) => (
              <button
                key={thm}
                onClick={() => setTheme(thm)}
                style={{
                  padding:      '8px 20px',
                  borderRadius: 'var(--radius-md)',
                  border:       '1px solid',
                  borderColor:  theme === thm ? 'var(--color-accent)' : 'var(--color-border)',
                  background:   theme === thm ? 'var(--color-accent-muted)' : 'var(--color-surface)',
                  color:        theme === thm ? 'var(--color-accent)' : 'var(--color-text)',
                  fontWeight:   theme === thm ? 600 : 400,
                  cursor:       'pointer',
                  fontSize:     '16px',
                  transition:   'all var(--transition-fast)',
                }}
              >
                {thm === 'light' ? t('gui.settings.light') : t('gui.settings.dark')}
              </button>
            ))}
          </div>
        </section>

        {/* Logging */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.logging')}</h2>
          <div className="page-settings--toggle-box">
            <div className="page-settings--toggle-row">
              <div>
                <span className="page-settings--toggle-label">
                  {t('gui.settings.error_logging')}
                </span>
                <p className="page-settings--toggle-desc">
                  {t('gui.settings.error_logging_desc')}
                </p>
              </div>
              {/* Toggle switch */}
              <button
                role="switch"
                aria-checked={errorLogging ?? false}
                disabled={errorLogging === null || errorLoggingBusy}
                onClick={() => { void handleErrorLoggingToggle(); }}
                title={errorLogging ? 'Click to disable error logging' : 'Click to enable error logging'}
                style={{
                  flexShrink:      0,
                  width:           '44px',
                  height:          '24px',
                  borderRadius:    '12px',
                  border:          'none',
                  background:      errorLogging ? 'var(--color-success)' : 'var(--color-border)',
                  cursor:          errorLogging === null || errorLoggingBusy ? 'default' : 'pointer',
                  position:        'relative',
                  transition:      'background 0.2s ease',
                  opacity:         errorLogging === null || errorLoggingBusy ? 0.6 : 1,
                }}
              >
                <span style={{
                  position:    'absolute',
                  top:         '3px',
                  left:        errorLogging ? '23px' : '3px',
                  width:       '18px',
                  height:      '18px',
                  borderRadius: '50%',
                  background:  'white',
                  transition:  'left 0.2s ease',
                  boxShadow:   '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>
            {errorLoggingError && (
              <p className="page-settings--error-msg-sm">{errorLoggingError}</p>
            )}
            <p className="page-settings--toggle-note">
              {t('gui.settings.error_logging_retrieve')}{' '}
              <code style={{ fontSize: '13px' }}>{t('gui.settings.error_logging_retrieve_cmd')}</code>.
            </p>
          </div>

          {/* Recent Errors */}
          <div style={{ marginTop: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-text)' }}>
                {t('gui.settings.recent_errors')}
              </span>
              <button
                onClick={() => { void loadRecentErrors(); }}
                disabled={errorsLoading}
                style={{
                  fontSize: '13px', padding: '2px 8px', borderRadius: '4px',
                  border: '1px solid var(--color-border)', background: 'transparent',
                  color: 'var(--color-text-secondary)', cursor: errorsLoading ? 'default' : 'pointer',
                }}
              >
                {errorsLoading ? t('gui.settings.recent_errors_loading') : t('gui.settings.recent_errors_refresh')}
              </button>
            </div>
            <div style={{
              background:   'var(--color-bg-secondary)',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              maxHeight:    '200px',
              overflowY:    'auto',
              fontSize:     '16px',
            }}>
              {recentErrors === null || errorsLoading ? (
                <div style={{ padding: '12px', color: 'var(--color-text-secondary)' }}>
                  {t('gui.settings.recent_errors_loading')}
                </div>
              ) : recentErrors.length === 0 ? (
                <div style={{ padding: '12px', color: 'var(--color-text-secondary)' }}>
                  {t('gui.settings.recent_errors_empty')}
                </div>
              ) : recentErrors.map((e) => (
                <div key={e.id} style={{
                  padding:      '8px 12px',
                  borderBottom: '1px solid var(--color-border)',
                  display:      'flex',
                  gap:          '8px',
                  alignItems:   'flex-start',
                }}>
                  <span style={{ color: e.severity === 'critical' ? 'var(--color-danger)' : 'var(--color-warning)', flexShrink: 0, fontWeight: 700 }}>
                    {e.severity.toUpperCase()}
                  </span>
                  <div>
                    <div style={{ color: 'var(--color-text)', fontWeight: 500 }}>{e.title}</div>
                    <div style={{ color: 'var(--color-text-secondary)', marginTop: '2px' }}>
                      {new Date(e.timestamp).toLocaleString()} · {e.event_type}
                      {e.agent_id ? ` · ${e.agent_id}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Security (Bouncer) */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.security_header')}</h2>
          <div className="page-settings--toggle-box">
            {/* Bouncer enabled toggle */}
            <div className="page-settings--toggle-row">
              <div>
                <span className="page-settings--toggle-label">
                  {t('gui.settings.bouncer_enabled')}
                </span>
                <p className="page-settings--toggle-desc">
                  {t('gui.settings.bouncer_enabled_desc')}
                </p>
              </div>
              <button
                role="switch"
                aria-checked={bouncerEnabled ?? false}
                disabled={bouncerEnabled === null || bouncerBusy}
                onClick={() => { void handleBouncerToggle(); }}
                title={bouncerEnabled ? 'Click to disable sensitive data scanning' : 'Click to enable sensitive data scanning'}
                style={{
                  flexShrink:  0,
                  width:       '44px',
                  height:      '24px',
                  borderRadius: '12px',
                  border:      'none',
                  background:  bouncerEnabled ? 'var(--color-success)' : 'var(--color-border)',
                  cursor:      bouncerEnabled === null || bouncerBusy ? 'default' : 'pointer',
                  position:    'relative',
                  transition:  'background 0.2s ease',
                  opacity:     bouncerEnabled === null || bouncerBusy ? 0.6 : 1,
                }}
              >
                <span style={{
                  position:    'absolute',
                  top:         '3px',
                  left:        bouncerEnabled ? '23px' : '3px',
                  width:       '18px',
                  height:      '18px',
                  borderRadius: '50%',
                  background:  'white',
                  transition:  'left 0.2s ease',
                  boxShadow:   '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>

            {/* Sensitivity dropdown — only shown when bouncer enabled */}
            {bouncerEnabled === true && (
              <div className="page-settings--sensitivity-row">
                <span className="page-settings--sensitivity-label">
                  {t('gui.settings.bouncer_sensitivity')}
                </span>
                <select
                  value={bouncerSensitivity}
                  disabled={bouncerBusy}
                  onChange={(e) => { void handleBouncerSensitivity(e.target.value as 'strict' | 'normal' | 'relaxed'); }}
                  className="page-settings--select"
                >
                  <option value="strict">{t('gui.settings.bouncer_sensitivity_strict')}</option>
                  <option value="normal">{t('gui.settings.bouncer_sensitivity_normal')}</option>
                  <option value="relaxed">{t('gui.settings.bouncer_sensitivity_relaxed')}</option>
                </select>
              </div>
            )}

            {bouncerError && (
              <p className="page-settings--error-msg-sm">{bouncerError}</p>
            )}
          </div>
        </section>

        {/* About */}
        <section className="page-settings--section">
          <h2 className="page-settings--section-h2">{t('gui.settings.about')}</h2>
          <div className="page-settings--about-rows">
            <AboutRow
              label={t('gui.settings.version')}
              value={buildInfo
                ? `${buildInfo.version}${buildInfo.buildNumber ? `-${buildInfo.buildNumber}` : ''}`
                : 'dev'}
            />
            {buildInfo?.buildDate && (
              <AboutRow label={t('gui.settings.build')} value={buildInfo.buildDate} />
            )}
            {buildInfo?.buildRef && (
              <AboutRow label={t('gui.settings.build_ref')} value={buildInfo.buildRef} />
            )}
            {!buildInfo?.buildDate && (
              <p className="page-settings--dev-mode-note">
                {t('gui.settings.dev_mode')}
              </p>
            )}
          </div>
          <UpdateCheckRow />
        </section>
      </div>

      {/* ── Right column: help panel (hidden on narrow screens via CSS media query) ── */}
      <div className="settings-help-panel">
        <SettingsHelpPanel />
      </div>

      {showStartOver && (
        <StartOverModal
          onComplete={() => {
            setShowStartOver(false);
            toast.success('Fresh workspace ready. Welcome back!');
            setTimeout(() => { window.location.hash = '#/'; }, 800);
          }}
          onCancel={() => setShowStartOver(false)}
        />
      )}
    </div>
  );
}


type UpdateCheckState = 'idle' | 'checking' | 'uptodate' | 'available' | 'starting' | 'error';

function UpdateCheckRow() {
  const { t }           = useTranslation();
  const [status, setStatus]   = useState<UpdateCheckState>('idle');
  const [latestVer, setLatestVer] = useState('');
  const [errMsg, setErrMsg]   = useState('');

  const handleCheck = useCallback(async () => {
    setStatus('checking');
    setErrMsg('');
    const csrf = getCsrfToken();
    const headers: Record<string, string> = { 'X-SIDJUA-Request': '1' };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    try {
      const r = await fetch('/api/v1/update/check', { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as { hasUpdate: boolean; latest: string };
      if (data.hasUpdate) {
        setLatestVer(data.latest);
        setStatus('available');
      } else {
        setStatus('uptodate');
      }
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  const handleUpdate = useCallback(async () => {
    setStatus('starting');
    const csrf = getCsrfToken();
    const headers: Record<string, string> = {
      'Content-Type':     'application/json',
      'X-SIDJUA-Request': '1',
    };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    try {
      await fetch('/api/v1/update/start', {
        method: 'POST',
        headers,
        body:   JSON.stringify({ version: latestVer }),
      });
    } catch {
      /* UpdateBanner takes over once the update stream starts */
    }
  }, [latestVer]);

  const icon =
    status === 'uptodate'  ? '✓' :
    status === 'available' ? '↑' :
    status === 'error'     ? '✕' :
    status === 'checking' || status === 'starting' ? '…' : '';

  const iconClass =
    status === 'uptodate'  ? 'update-check--ok' :
    status === 'available' ? 'update-check--available' :
    status === 'error'     ? 'update-check--error' : '';

  const msg =
    status === 'idle'      ? '' :
    status === 'checking'  ? t('gui.settings.update.checking') :
    status === 'uptodate'  ? t('gui.settings.update.uptodate') :
    status === 'available' ? t('gui.settings.update.available', { version: latestVer }) :
    status === 'starting'  ? t('gui.settings.update.starting') :
    t('gui.settings.update.error', { message: errMsg });

  return (
    <div className="page-settings--update-check">
      <div className="update-check--row">
        {icon && (
          <span className={`update-check--icon ${iconClass}`}>{icon}</span>
        )}
        <span className="update-check--msg">{msg || t('gui.settings.update.title')}</span>
      </div>
      {(status === 'idle' || status === 'uptodate' || status === 'error') && (
        <button
          onClick={() => { void handleCheck(); }}
          style={primaryButtonStyle(false)}
        >
          {t('gui.settings.update.check')}
        </button>
      )}
      {status === 'available' && (
        <button
          onClick={() => { void handleUpdate(); }}
          style={primaryButtonStyle(false)}
        >
          {t('update.now')}
        </button>
      )}
    </div>
  );
}


function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="page-settings--about-row">
      <span className="page-settings--about-label">
        {label}
      </span>
      <code className="page-settings--about-value">
        {value}
      </code>
    </div>
  );
}


function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding:         '8px 20px',
    borderRadius:    'var(--radius-md)',
    border:          'none',
    background:      disabled ? 'var(--color-border)' : 'var(--color-accent)',
    color:           disabled ? 'var(--color-text-muted)' : 'var(--color-on-accent)',
    fontWeight:      600,
    fontSize:        '16px',
    cursor:          disabled ? 'not-allowed' : 'pointer',
    transition:      'background var(--transition-fast)',
    display:         'inline-flex',
    alignItems:      'center',
    gap:             '6px',
  };
}

