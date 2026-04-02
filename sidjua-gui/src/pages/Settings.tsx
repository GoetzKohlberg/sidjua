// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useAppConfig, getIsBootstrapSession } from '../lib/config';
import type { AppConfig, BuildInfo } from '../lib/config';
import type { LoggingStatus } from '../api/types';
import { useApi } from '../hooks/useApi';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../hooks/useTranslation';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import { useToast } from '../components/shared/Toast';
import type { ApprovedProvider, ProviderConfigResponse } from '../api/types';
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
          fontSize:     '14px',
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

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text)' }}>
            {provider.display_name}
          </span>
          {provider.recommended && (
            <span style={{
              background:   'var(--color-llm-warn-bg)',
              color:        'var(--color-llm-warn-text)',
              fontSize:     '10px',
              fontWeight:   700,
              padding:      '1px 6px',
              borderRadius: '4px',
              letterSpacing: '0.03em',
            }}>
              {t('gui.settings.provider.recommended_badge')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
          {isFree ? (
            <span style={{
              background: 'var(--color-success-bg)',
              color:      'var(--color-success)',
              fontSize:   '10px',
              fontWeight: 700,
              padding:    '1px 6px',
              borderRadius: '4px',
            }}>
              {t('gui.settings.provider.free_badge')}
            </span>
          ) : (
            <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              ${provider.input_price}/${provider.output_price} per 1M
            </span>
          )}

          <span style={{
            fontSize:   '10px',
            fontWeight: 700,
            color:      qualityColor,
            padding:    '1px 5px',
            border:     `1px solid ${qualityColor}`,
            borderRadius: '4px',
          }}>
            {provider.quality}
          </span>

          {isFree && provider.rate_limit !== 'none' && (
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>
              {provider.rate_limit}
            </span>
          )}
        </div>

        <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
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
    <div style={keySectionStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)', margin: 0 }}>
          {isCustom ? t('gui.settings.provider.custom_setup') : provider?.display_name}
        </h3>
        {!isCustom && provider && (
          <a
            href={provider.signup_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '12px', color: 'var(--color-accent)', textDecoration: 'none' }}
          >
            {t('gui.settings.provider.sign_up')}
          </a>
        )}
      </div>

      {/* Custom fields */}
      {isCustom && (
        <>
          <label style={labelStyle}>
            {t('gui.settings.provider.name')}
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="e.g. My Ollama, Anthropic Claude"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            {t('gui.settings.provider.api_base')}
            <input
              type="url"
              value={customBase}
              onChange={(e) => setCustomBase(e.target.value)}
              placeholder="https://api.openai.com/v1 or http://localhost:11434/v1"
              style={inputStyle}
              spellCheck={false}
            />
          </label>
          <label style={labelStyle}>
            {t('gui.settings.provider.model')}
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. claude-sonnet-4-20250514, llama3.3:70b"
              style={inputStyle}
              spellCheck={false}
            />
          </label>
        </>
      )}

      {/* API key input */}
      <label style={labelStyle}>
        {t('gui.settings.provider.api_key')}{' '}
        {isCustom && <span style={{ fontWeight: 400 }}>{t('gui.settings.provider.api_key_optional')}</span>}
        <div style={{ position: 'relative' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setTestStatus('idle'); }}
            placeholder={isCustom ? t('gui.settings.provider.key_placeholder_local') : t('gui.settings.provider.key_placeholder_cloud')}
            style={{ ...inputStyle, paddingRight: '40px' }}
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
              fontSize:   '14px',
              padding:    '2px 4px',
            }}
          >
            {showKey ? '🙈' : '👁'}
          </button>
        </div>
      </label>

      {/* Test result */}
      {testStatus === 'ok' && (
        <div style={{ fontSize: '13px', color: 'var(--color-success)', marginBottom: '12px' }}>
          ✅ {testMessage}{responseMs !== null ? ` Response in ${responseMs}ms.` : ''}
        </div>
      )}
      {testStatus === 'error' && (
        <div style={{ fontSize: '13px', color: 'var(--color-danger)', marginBottom: '12px' }}>
          ❌ {testMessage}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={() => { void handleTest(); }}
          disabled={testing || (!apiKey.trim() && !isCustom)}
          style={secondaryButtonStyle}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '8px' }}>
        {t('gui.settings.provider.advanced_desc')}
      </p>
      {AGENT_IDS.map((agentId) => (
        <div key={agentId} style={{
          display:      'flex',
          alignItems:   'center',
          gap:          '12px',
          padding:      '10px 14px',
          background:   'var(--color-bg)',
          border:       '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
        }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text)', width: '100px', flexShrink: 0, textTransform: 'capitalize' }}>
            {agentId}
          </span>
          <select
            value={overrides[agentId] ?? 'default'}
            onChange={(e) => setOverrides((prev) => ({ ...prev, [agentId]: e.target.value }))}
            style={{ ...selectStyle, flex: 1 }}
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
      <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '12px', lineHeight: 1.6 }}>
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
      <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
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
        <div style={{
          background:   'var(--color-llm-ready-bg)',
          border:       '1px solid var(--color-llm-ready-border)',
          borderRadius: 'var(--radius-md)',
          padding:      '10px 14px',
          marginBottom: '16px',
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'space-between',
          gap:          '8px',
        }}>
          <span style={{ fontSize: '13px', color: 'var(--color-success)' }}>
            ✅ {currentConfig.default_provider.display_name} — {currentConfig.default_provider.api_key_preview}
          </span>
          <button
            onClick={() => { void handleReset(); }}
            style={{
              background:   'none',
              border:       '1px solid var(--color-llm-ready-border)',
              borderRadius: 'var(--radius-md)',
              color:        'var(--color-success)',
              cursor:       'pointer',
              fontSize:     '12px',
              padding:      '2px 8px',
            }}
          >
            {t('gui.settings.provider.change')}
          </button>
        </div>
      )}

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', alignItems: 'center' }}>
        <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)', fontWeight: 500 }}>
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
              fontSize:     '13px',
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
          <div style={dividerStyle}>{t('gui.settings.provider.free_providers')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
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
          <div style={dividerStyle}>{t('gui.settings.provider.paid_providers')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
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
          <div style={dividerStyle}>{t('gui.settings.provider.custom_provider')}</div>
          <div style={{ marginBottom: '16px' }}>
            <button
              onClick={() => { setShowCustom((v) => !v); setSelectedId(null); }}
              style={{
                ...secondaryButtonStyle,
                background: showCustom ? 'var(--color-accent-muted)' : undefined,
                borderColor: showCustom ? 'var(--color-accent)' : undefined,
                color:       showCustom ? 'var(--color-accent)' : undefined,
              }}
            >
              {showCustom ? '▼' : '▶'} {showCustom ? t('gui.settings.provider.custom_label') : t('gui.settings.provider.add_custom')}
            </button>
            {!showCustom && (
              <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '6px' }}>
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
    <aside style={{
      display:        'flex',
      flexDirection:  'column',
      gap:            '16px',
      position:       'sticky',
      top:            '24px',
      alignSelf:      'flex-start',
    }}>
      {/* Getting Started */}
      <div style={helpCardStyle}>
        <h3 style={helpHeadingStyle}>{t('gui.settings.help.getting_started')}</h3>

        {/* API key callout — prominent */}
        <div style={{
          background:   'var(--color-accent-subtle, rgba(99,102,241,0.08))',
          border:       '1px solid var(--color-accent-border, rgba(99,102,241,0.2))',
          borderLeft:   '4px solid var(--color-accent)',
          borderRadius: 'var(--radius-md)',
          padding:      '12px 14px',
          marginBottom: '12px',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-text)', marginBottom: '6px' }}>
            {t('gui.settings.help.where_apikey')}
          </div>
          <code style={{
            display:      'block',
            fontFamily:   'monospace',
            fontSize:     '11px',
            background:   'var(--color-bg)',
            color:        'var(--color-text)',
            padding:      '6px 8px',
            borderRadius: 'var(--radius-sm)',
            border:       '1px solid var(--color-border)',
            marginBottom: '6px',
            userSelect:   'all',
          }}>
            {t('gui.settings.help.apikey_command')}
          </code>
          <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {t('gui.settings.help.container_note')}
          </div>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', lineHeight: '1.7' }}>
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
      <div style={helpCardStyle}>
        <h3 style={helpHeadingStyle}>{t('gui.settings.help.about_settings')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {helpSections.map(({ key, label }) => (
            <div key={key}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-text)', marginBottom: '2px' }}>
                {label}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
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
  const { config, status, client, setConfig, testConnection, buildInfo } = useAppConfig();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const toast = useToast();

  const [form,          setForm]          = useState<AppConfig>({
    ...config,
    // Don't pre-fill the key field with the auto-exchanged bootstrap token —
    // the user must explicitly enter their own key.
    apiKey: getIsBootstrapSession() ? '' : config.apiKey,
  });
  const [testing,       setTesting]       = useState(false);
  const [providerKey,   setProviderKey]   = useState(0); // force re-render on provider save
  const [showStartOver, setShowStartOver] = useState(false);
  const [showApiKey,    setShowApiKey]    = useState(false);

  // Error logging toggle
  const loggingRes = useApi<LoggingStatus>((c) => c.loggingStatus());
  const [errorLogging,       setErrorLogging]       = useState<boolean | null>(null);
  const [errorLoggingBusy,   setErrorLoggingBusy]   = useState(false);
  const [errorLoggingError,  setErrorLoggingError]  = useState<string | null>(null);
  const errorLoggingInitRef = useRef(false);

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

  function handleChange(field: keyof AppConfig) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
    };
  }

  function handleApiKeyInput(e: React.FormEvent<HTMLInputElement>) {
    setForm((prev) => ({ ...prev, apiKey: (e.target as HTMLInputElement).value }));
  }

  function handleSave() {
    setConfig(form);
    toast.success('Settings saved.');
  }

  async function handleTest() {
    setConfig(form);
    setTesting(true);
    const ok = await testConnection();
    setTesting(false);
    if (ok) {
      toast.success('Connection successful — server is reachable.');
    } else {
      toast.error(`${GUI_ERRORS['GUI-SETTINGS-002'].message} ${GUI_ERRORS['GUI-SETTINGS-002'].suggestion}`);
    }
  }

  const isDirty =
    form.serverUrl !== config.serverUrl ||
    form.apiKey    !== config.apiKey;

  return (
    <div style={{
      display:               'grid',
      gridTemplateColumns:   'minmax(0, 620px) minmax(260px, 360px)',
      gap:                   '24px',
      alignItems:            'flex-start',
    }}>
      {/* ── Left column: settings cards ── */}
      <div>
        {/* Server Connection */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.server_connection')}</h2>

          <label style={labelStyle}>
            {t('gui.settings.server_url')}
            <input
              type="url"
              value={form.serverUrl}
              onChange={handleChange('serverUrl')}
              placeholder="http://localhost:3000"
              style={inputStyle}
              spellCheck={false}
            />
          </label>

          <label style={labelStyle}>
            {t('gui.settings.api_key')}
            <div style={{ position: 'relative' }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={handleChange('apiKey')}
                onInput={handleApiKeyInput}
                placeholder="sk-…"
                style={{ ...inputStyle, paddingRight: '40px' }}
                autoComplete="current-password"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                aria-label={showApiKey ? t('gui.settings.hide_api_key') : t('gui.settings.show_api_key')}
                style={{
                  position:        'absolute',
                  right:           '8px',
                  top:             '50%',
                  transform:       'translateY(-50%)',
                  background:      'none',
                  border:          'none',
                  cursor:          'pointer',
                  color:           'var(--color-text-muted)',
                  padding:         '2px',
                  display:         'flex',
                  alignItems:      'center',
                }}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleSave}
              disabled={!isDirty}
              style={primaryButtonStyle(!isDirty)}
            >
              {t('gui.settings.save')}
            </button>

            <button
              onClick={() => { void handleTest(); }}
              disabled={testing}
              style={secondaryButtonStyle}
            >
              {testing ? <LoadingSpinner size="sm" label={t('gui.settings.testing')} /> : t('gui.settings.test_connection')}
            </button>
          </div>

          {status === 'connected' && (
            <p style={{ fontSize: '13px', color: 'var(--color-success)', marginTop: '8px' }}>
              {t('gui.settings.connected')}
            </p>
          )}
        </section>

        {/* LLM Provider */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.llm_provider')}</h2>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
            {t('gui.settings.llm_provider_desc')}
          </p>
          <ProviderSettings key={providerKey} onConfigChange={() => setProviderKey((k) => k + 1)} />
        </section>

        {/* Workspace */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.workspace')}</h2>

          {/* Backup guidance */}
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px', lineHeight: 1.6 }}>
            {t('gui.settings.workspace_backup_hint')}
          </p>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
            <button
              disabled
              title={t('gui.settings.workspace_coming_soon')}
              style={{
                padding:      '9px 20px',
                borderRadius: 'var(--radius-md)',
                border:       '1px solid var(--color-accent)',
                background:   'var(--color-accent)',
                color:        'var(--color-text-inverse)',
                fontWeight:   600,
                fontSize:     '14px',
                cursor:       'not-allowed',
                opacity:      0.5,
              }}
            >
              {t('gui.settings.workspace_backup_button')}
            </button>
            <button
              disabled
              title={t('gui.settings.workspace_coming_soon')}
              style={{
                padding:      '9px 20px',
                borderRadius: 'var(--radius-md)',
                border:       '1px solid var(--color-accent)',
                background:   'transparent',
                color:        'var(--color-accent)',
                fontWeight:   600,
                fontSize:     '14px',
                cursor:       'not-allowed',
                opacity:      0.5,
              }}
            >
              {t('gui.settings.workspace_restore_button')}
            </button>
          </div>

          {/* Separator */}
          <div style={{ borderTop: '1px solid var(--color-border)', marginBottom: '16px' }} />

          {/* Reset / Start Over */}
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '12px', lineHeight: 1.6 }}>
            {t('gui.settings.workspace_reset_warning')}
          </p>
          <button
            onClick={() => setShowStartOver(true)}
            style={{
              padding:      '9px 20px',
              borderRadius: 'var(--radius-md)',
              border:       '1px solid #f59e0b',
              background:   'transparent',
              color:        '#b45309',
              fontWeight:   600,
              fontSize:     '14px',
              cursor:       'pointer',
              transition:   'all var(--transition-fast)',
            }}
          >
            {t('gui.settings.start_over')}
          </button>
        </section>

        {/* Language */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.language')}</h2>
          <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
            {t('gui.settings.language_desc')}
          </p>
          <LanguageSelector />
        </section>

        {/* Languages management (installed list) */}
        {installedLangs !== null && (
          <section style={sectionStyle}>
            <h2 style={sectionHeadingStyle}>{t('gui.settings.languages_header')}</h2>
            <div style={{
              background:    'var(--color-bg)',
              border:        '1px solid var(--color-border)',
              borderRadius:  'var(--radius-md)',
              padding:       '14px 16px',
              display:       'flex',
              flexDirection: 'column',
              gap:           '8px',
            }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                {t('gui.settings.languages_installed')}
              </div>
              {installedLangs.map((code) => (
                <div key={code} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ fontSize: '13px', color: 'var(--color-text)' }}>
                    {code}
                    {code === activeLang && (
                      <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--color-success)', fontWeight: 600 }}>
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
                        fontSize:     '11px',
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--color-border)' }}>
                    <select
                      value={addLangCode}
                      onChange={(e) => setAddLangCode(e.target.value)}
                      disabled={langBusy}
                      style={{ ...selectStyle, flex: 1 }}
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
                        fontSize:     '13px',
                        opacity:      langBusy || addLangCode === '' ? 0.5 : 1,
                      }}
                    >
                      {t('gui.settings.languages_add')}
                    </button>
                  </div>
                );
              })()}

              {langError && (
                <p style={{ fontSize: '12px', color: 'var(--color-danger)', margin: 0 }}>{langError}</p>
              )}
            </div>
          </section>
        )}

        {/* Appearance */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.appearance')}</h2>

          <div style={{ display: 'flex', gap: '8px' }}>
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
                  fontSize:     '14px',
                  transition:   'all var(--transition-fast)',
                }}
              >
                {thm === 'light' ? t('gui.settings.light') : t('gui.settings.dark')}
              </button>
            ))}
          </div>
        </section>

        {/* Logging */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.logging')}</h2>
          <div style={{
            background:   'var(--color-bg)',
            border:       '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding:      '14px 16px',
            display:      'flex',
            flexDirection: 'column',
            gap:          '8px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <div>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text)' }}>
                  {t('gui.settings.error_logging')}
                </span>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>
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
              <p style={{ fontSize: '12px', color: 'var(--color-danger)', margin: 0 }}>{errorLoggingError}</p>
            )}
            <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: 0 }}>
              {t('gui.settings.error_logging_retrieve')}{' '}
              <code style={{ fontSize: '11px' }}>{t('gui.settings.error_logging_retrieve_cmd')}</code>.
            </p>
          </div>
        </section>

        {/* Security (Bouncer) */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.security_header')}</h2>
          <div style={{
            background:    'var(--color-bg)',
            border:        '1px solid var(--color-border)',
            borderRadius:  'var(--radius-md)',
            padding:       '14px 16px',
            display:       'flex',
            flexDirection: 'column',
            gap:           '8px',
          }}>
            {/* Bouncer enabled toggle */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <div>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text)' }}>
                  {t('gui.settings.bouncer_enabled')}
                </span>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
                <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)', flex: 1 }}>
                  {t('gui.settings.bouncer_sensitivity')}
                </span>
                <select
                  value={bouncerSensitivity}
                  disabled={bouncerBusy}
                  onChange={(e) => { void handleBouncerSensitivity(e.target.value as 'strict' | 'normal' | 'relaxed'); }}
                  style={selectStyle}
                >
                  <option value="strict">{t('gui.settings.bouncer_sensitivity_strict')}</option>
                  <option value="normal">{t('gui.settings.bouncer_sensitivity_normal')}</option>
                  <option value="relaxed">{t('gui.settings.bouncer_sensitivity_relaxed')}</option>
                </select>
              </div>
            )}

            {bouncerError && (
              <p style={{ fontSize: '12px', color: 'var(--color-danger)', margin: 0 }}>{bouncerError}</p>
            )}
          </div>
        </section>

        {/* About */}
        <section style={sectionStyle}>
          <h2 style={sectionHeadingStyle}>{t('gui.settings.about')}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
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
              <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', margin: 0 }}>
                {t('gui.settings.dev_mode')}
              </p>
            )}
          </div>
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


function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'baseline' }}>
      <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', minWidth: '64px' }}>
        {label}
      </span>
      <code style={{ fontSize: '12px', color: 'var(--color-text)', fontFamily: 'monospace' }}>
        {value}
      </code>
    </div>
  );
}


const sectionStyle: React.CSSProperties = {
  background:    'var(--color-surface)',
  border:        '1px solid var(--color-border)',
  borderRadius:  'var(--radius-lg)',
  padding:       '24px',
  marginBottom:  '20px',
  boxShadow:     'var(--shadow-sm)',
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize:      '15px',
  fontWeight:    600,
  marginBottom:  '20px',
  color:         'var(--color-text)',
};

const helpCardStyle: React.CSSProperties = {
  background:   'var(--color-surface)',
  border:       '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)',
  padding:      '20px',
  boxShadow:    'var(--shadow-sm)',
};

const helpHeadingStyle: React.CSSProperties = {
  fontSize:     '13px',
  fontWeight:   700,
  color:        'var(--color-text)',
  marginBottom: '12px',
  marginTop:    0,
};

const labelStyle: React.CSSProperties = {
  display:       'flex',
  flexDirection: 'column',
  gap:           '6px',
  fontSize:      '13px',
  fontWeight:    500,
  color:         'var(--color-text-secondary)',
  marginBottom:  '16px',
};

const inputStyle: React.CSSProperties = {
  padding:       '8px 12px',
  borderRadius:  'var(--radius-md)',
  border:        '1px solid var(--color-border)',
  background:    'var(--color-bg)',
  color:         'var(--color-text)',
  fontSize:      '14px',
  outline:       'none',
  transition:    'border-color var(--transition-fast)',
  width:         '100%',
  boxSizing:     'border-box',
};

const selectStyle: React.CSSProperties = {
  padding:      '6px 10px',
  borderRadius: 'var(--radius-md)',
  border:       '1px solid var(--color-border)',
  background:   'var(--color-bg)',
  color:        'var(--color-text)',
  fontSize:     '13px',
  outline:      'none',
};

const keySectionStyle: React.CSSProperties = {
  background:   'var(--color-surface-alt, #f9fafb)',
  border:       '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding:      '16px',
  marginTop:    '4px',
};

const dividerStyle: React.CSSProperties = {
  fontSize:      '11px',
  fontWeight:    700,
  color:         'var(--color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom:  '10px',
  paddingBottom: '6px',
  borderBottom:  '1px solid var(--color-border)',
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding:         '8px 20px',
    borderRadius:    'var(--radius-md)',
    border:          'none',
    background:      disabled ? 'var(--color-border)' : 'var(--color-accent)',
    color:           disabled ? 'var(--color-text-muted)' : 'var(--color-on-accent)',
    fontWeight:      600,
    fontSize:        '14px',
    cursor:          disabled ? 'not-allowed' : 'pointer',
    transition:      'background var(--transition-fast)',
    display:         'inline-flex',
    alignItems:      'center',
    gap:             '6px',
  };
}

const secondaryButtonStyle: React.CSSProperties = {
  padding:         '8px 20px',
  borderRadius:    'var(--radius-md)',
  border:          '1px solid var(--color-border)',
  background:      'var(--color-surface)',
  color:           'var(--color-text)',
  fontWeight:      500,
  fontSize:        '14px',
  cursor:          'pointer',
  display:         'inline-flex',
  alignItems:      'center',
  gap:             '8px',
  transition:      'all var(--transition-fast)',
};

export default Settings;
