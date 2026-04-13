// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { ArrowLeft, Play } from 'lucide-react';

import { useAppConfig }  from '../lib/config';
import { useApi }        from '../hooks/useApi';
import { AgentIcon }     from '../components/shared/AgentIcon';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import type { StarterAgentsResponse, ProviderConfigResponse, ScanResult } from '../api/types';
import { GUI_ERRORS } from '../i18n/gui-errors';
import { useTranslation } from '../hooks/useTranslation';
import { ChatUploadZone, PaperclipButton } from '../components/chat/ChatUploadZone';
import { FileReferenceCard }               from '../components/chat/FileReferenceCard';
import { useSse }                          from '../hooks/useSse';
import { RedactionDialog }                 from '../components/chat/RedactionDialog';


interface Message {
  id:          string;
  role:        'user' | 'assistant' | 'tool_call' | 'tool_result' | 'file_upload';
  content:     string;
  timestamp:   string;
  isStreaming?: boolean;
  toolName?:   string;
  toolSuccess?: boolean;
  toolData?:   unknown;
  toolError?:  string | null;
  uploadId?:        string;
  uploadFilename?:  string;
  uploadSize?:      number;
  uploadMimetype?:  string;
  uploadStatus?:    string;
}

interface StarterAgentShape {
  id:          string;
  name:        string;
  description: string;
  icon:        string;
}


function AgentSwitcher({
  agents,
  currentId,
  providerConfigured,
}: {
  agents:             StarterAgentShape[];
  currentId:          string;
  providerConfigured: boolean;
}) {
  const navigate = useNavigate();

  return (
    <div className="page-chat--switcher">
      {agents.map((agent) => {
        const isActive = agent.id === currentId;
        return (
          <button
            key={agent.id}
            onClick={() => navigate(`/chat/${agent.id}`)}
            title={agent.name}
            aria-label={`Chat with ${agent.name}`}
            aria-pressed={isActive}
            style={{
              display:        'inline-flex',
              alignItems:     'center',
              gap:            '6px',
              padding:        '5px 10px',
              borderRadius:   'var(--radius-md)',
              border:         `1px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background:     isActive ? 'var(--color-accent-muted)' : 'var(--color-surface)',
              color:          isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              cursor:         'pointer',
              fontSize:       '16px',
              fontWeight:     isActive ? 600 : 400,
              whiteSpace:     'nowrap',
              flexShrink:     0,
            }}
          >
            <span style={{
              width:  '6px',
              height: '6px',
              borderRadius: '50%',
              background: providerConfigured ? 'var(--color-success)' : 'var(--color-text-muted)',
              flexShrink: 0,
            }} />
            <AgentIcon name={agent.icon} size={13} />
            {agent.name}
          </button>
        );
      })}
    </div>
  );
}


function ChatHeader({
  agent,
  onApply,
  applyState,
  onBack,
  showApply,
}: {
  agent:      StarterAgentShape;
  onApply:    () => void;
  applyState: 'idle' | 'running' | 'success' | 'error';
  onBack:     () => void;
  showApply?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="page-chat--header">
      <button
        onClick={onBack}
        aria-label={t('gui.chat.back_to_agents')}
        className="page-chat--back-btn"
      >
        <ArrowLeft size={16} />
      </button>

      <div className="page-chat--agent-icon">
        <AgentIcon name={agent.icon} size={16} />
      </div>

      <div className="page-chat--header-info">
        <div className="page-chat--header-name">
          {agent.name}
        </div>
        <div className="page-chat--header-desc">
          {agent.description}
        </div>
      </div>

      {showApply && <button
        onClick={onApply}
        disabled={applyState === 'running'}
        aria-label={t('gui.chat.apply_config_title')}
        title={t('gui.chat.apply_config_title')}
        style={{
          display:      'inline-flex',
          alignItems:   'center',
          gap:          '5px',
          padding:      '5px 10px',
          borderRadius: 'var(--radius-md)',
          border:       `1px solid ${
            applyState === 'success' ? 'var(--color-success, #15803d)' :
            applyState === 'error'   ? 'var(--color-danger, #dc2626)' :
            'var(--color-border)'
          }`,
          background:   'transparent',
          color:        applyState === 'success' ? 'var(--color-success, #15803d)' :
                        applyState === 'error'   ? 'var(--color-danger, #dc2626)' :
                        'var(--color-text-muted)',
          cursor:       applyState === 'running' ? 'not-allowed' : 'pointer',
          fontSize:     '16px',
          opacity:      applyState === 'running' ? 0.6 : 1,
        }}
      >
        {applyState === 'running' ? (
          <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        ) : (
          <Play size={12} />
        )}
        {applyState === 'running' ? 'Applying…' :
         applyState === 'success' ? 'Applied ✓' :
         applyState === 'error'   ? 'Failed ✗' :
         'Apply'}
      </button>}
    </div>
  );
}


function ToolCallCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  return (
    <div className="page-chat--tool-call-wrap">
      <div className="page-chat--tool-call-card">
        <div className="page-chat--tool-call-header">
          <span className="page-chat--tool-icon">⚙</span>
          <strong style={{ color: 'var(--color-text-secondary)' }}>
            {t('gui.chat.calling_tool_prefix')} {message.toolName ?? message.content}
          </strong>
        </div>
        {message.toolName && (
          <div style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '400px' }}>
            {message.content || '(no parameters)'}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolResultCard({ message }: { message: Message }) {
  const success = message.toolSuccess !== false;
  return (
    <div className="page-chat--tool-result-wrap">
      <div style={{
        maxWidth:     '80%',
        padding:      '8px 12px',
        borderRadius: 'var(--radius-md)',
        background:   success ? 'var(--color-success-bg, #f0fdf4)' : 'var(--color-danger-bg, #fef2f2)',
        border:       `1px solid ${success ? 'var(--color-success-border, #bbf7d0)' : 'var(--color-danger-border, #fecaca)'}`,
        fontSize:     '16px',
        color:        success ? 'var(--color-success, #15803d)' : 'var(--color-danger, #dc2626)',
        fontFamily:   'monospace',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span>{success ? '✓' : '✗'}</span>
          <strong>{message.toolName ?? 'Tool'}</strong>
          <span style={{ opacity: 0.7 }}>{success ? 'succeeded' : 'failed'}</span>
        </div>
        {!success && message.toolError && (
          <div style={{ marginTop: '4px', opacity: 0.85 }}>{message.toolError}</div>
        )}
        {success && (
          <div style={{ marginTop: '4px', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '400px' }}>
            {message.toolData !== undefined && message.toolData !== null
              ? (typeof message.toolData === 'object'
                  ? JSON.stringify(message.toolData).slice(0, 120)
                  : String(message.toolData).slice(0, 120))
              : '(completed)'}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'tool_call')   return <ToolCallCard   message={message} />;
  if (message.role === 'tool_result') return <ToolResultCard message={message} />;
  if (message.role === 'file_upload') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
        <FileReferenceCard
          filename={message.uploadFilename ?? 'file'}
          sizeBytes={message.uploadSize ?? 0}
          mimetype={message.uploadMimetype ?? 'application/octet-stream'}
          extractionStatus={message.uploadStatus}
        />
      </div>
    );
  }

  const isUser = message.role === 'user';

  return (
    <div style={{
      display:        'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom:   '12px',
    }}>
      <div
        title={new Date(message.timestamp).toLocaleString()}
        style={{
          maxWidth:     '70%',
          padding:      '10px 14px',
          borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          background:   isUser
            ? 'var(--color-accent)'
            : 'var(--color-surface-alt, #f3f4f6)',
          color:        isUser ? 'var(--color-on-accent)' : 'var(--color-text)',
          fontSize:     '16px',
          lineHeight:   1.55,
          whiteSpace:   'pre-wrap',
          wordBreak:    'break-word',
          border:       isUser ? 'none' : '1px solid var(--color-border)',
        }}
      >
        {isUser ? message.content : stripFunctionTags(message.content)}
        {message.isStreaming && (
          <span style={{ display: 'inline-block', marginLeft: '4px', animation: 'pulse 1s infinite' }}>
            ▋
          </span>
        )}
      </div>
    </div>
  );
}


function TypingIndicator() {
  return (
    <div className="page-chat--typing-indicator">
      <div className="page-chat--typing-bubble">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width:        '6px',
              height:       '6px',
              borderRadius: '50%',
              background:   'var(--color-text-muted)',
              animation:    `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  );
}


/** Strip Llama/XML tool call tags from assistant message text. */
function stripFunctionTags(text: string): string {
  return text
    .replace(/<function=[a-z_]+>[\s\S]*?<\/function>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim();
}

const VISIBLE_LIMIT = 50;

function ChatMessages({
  messages,
  isStreaming,
  agentName,
  providerConfigured,
  showAll,
  onShowAll,
}: {
  messages:    Message[];
  isStreaming: boolean;
  agentName:   string;
  providerConfigured: boolean;
  showAll:     boolean;
  onShowAll:   () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const hiddenCount     = showAll ? 0 : Math.max(0, messages.length - VISIBLE_LIMIT);
  const visibleMessages = showAll ? messages : messages.slice(-VISIBLE_LIMIT);

  return (
    <div className="page-chat--messages">
      {messages.length === 0 && !isStreaming && (
        <div className="page-chat--empty-state">
          <span className="page-chat--empty-emoji">💬</span>
          <p style={{ margin: 0 }}>
            {providerConfigured ? (<>{t('gui.chat.empty_state_prompt', { agentName })}<br /></>) : (<>{t('gui.chat.no_provider')}<br />{t('gui.chat.setup_provider')}<br /></>)}
            {t('gui.chat.type_message_below')}
          </p>
        </div>
      )}

      {hiddenCount > 0 && (
        <div className="page-chat--show-more-wrap">
          <button
            onClick={onShowAll}
            className="page-chat--show-more-btn"
          >
            Show {hiddenCount} earlier messages
          </button>
        </div>
      )}

      {visibleMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {isStreaming && messages.length > 0 && !messages[messages.length - 1]?.isStreaming && (
        <TypingIndicator />
      )}

      <div ref={bottomRef} />
    </div>
  );
}


function ChatInput({
  onSend,
  disabled,
  disabledReason,
  onOpenFilePicker,
  uploadInProgress,
}: {
  onSend:           (message: string) => void;
  disabled:         boolean;
  disabledReason?:  string;
  onOpenFilePicker?: () => void;
  uploadInProgress?: boolean;
}) {
  const [value, setValue] = useState('');
  const textareaRef       = useRef<HTMLTextAreaElement>(null);
  const { t }             = useTranslation();

  function handleSend() {
    const msg = value.trim();
    if (!msg || disabled) return;
    onSend(msg);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }

  return (
    <div className="page-chat--input-container">
      {disabledReason && (
        <div className="page-chat--disabled-msg">
          {disabledReason}
        </div>
      )}
      <div className="page-chat--input-row">
        {onOpenFilePicker && (
          <PaperclipButton
            onClick={onOpenFilePicker}
            disabled={disabled || uploadInProgress}
          />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? 'Configure an LLM provider in Settings to start chatting' : 'Type a message… (Enter to send, Shift+Enter for newline)'}
          rows={1}
          style={{
            flex:        1,
            resize:      'none',
            padding:     '10px 12px',
            borderRadius:'var(--radius-md)',
            border:      '1px solid var(--color-border)',
            background:  disabled ? 'var(--color-bg)' : 'var(--color-surface)',
            color:       'var(--color-text)',
            fontSize:    '16px',
            lineHeight:  1.5,
            outline:     'none',
            minHeight:   '40px',
            maxHeight:   '120px',
            fontFamily:  'inherit',
            cursor:      disabled ? 'not-allowed' : 'text',
            opacity:     disabled ? 0.6 : 1,
          }}
        />
        <button
          onClick={handleSend}
          disabled={disabled || value.trim() === ''}
          aria-label={t('gui.chat.aria_send_message')}
          style={{
            padding:      '10px 16px',
            borderRadius: 'var(--radius-md)',
            border:       'none',
            background:   disabled || value.trim() === '' ? 'var(--color-border)' : 'var(--color-accent)',
            color:        disabled || value.trim() === '' ? 'var(--color-text-muted)' : 'var(--color-on-accent)',
            cursor:       disabled || value.trim() === '' ? 'not-allowed' : 'pointer',
            fontSize:     '15px',
            fontWeight:   600,
            display:      'flex',
            alignItems:   'center',
            gap:          '6px',
            flexShrink:   0,
            height:       '40px',
            transition:   'background 0.15s ease',
          }}
        >
          {/* Inline arrow icon — no external deps */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          Send
        </button>
      </div>
      <div className="page-chat--footer">
        SIDJUA agents use AI models that can make mistakes. Please verify important information.
        <span className="page-chat--footer-version">
          SIDJUA 1.0 — Development Preview
        </span>
      </div>
    </div>
  );
}


const AGENT_ORDER = ['guide', 'hr', 'it', 'auditor', 'finance', 'librarian'];

export function Chat() {
  const { agentId = 'guide' } = useParams<{ agentId: string }>();
  const navigate               = useNavigate();
  const { client, config }     = useAppConfig();
  const baseUrl                = config.serverUrl;
  const { t }                  = useTranslation();

  const agentsRes   = useApi<StarterAgentsResponse>((c) => c.listStarterAgents());
  const providerRes = useApi<ProviderConfigResponse>((c) => c.getProviderConfig());

  const [messages,     setMessages]    = useState<Message[]>([]);
  const [isStreaming,  setIsStreaming] = useState(false);
  const [convId,       setConvId]     = useState<string | null>(null);
  const [showAll,      setShowAll]    = useState(false);
  const [applyState,   setApplyState] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [pendingScan,  setPendingScan] = useState<{ scanResult: ScanResult; originalMessage: string } | null>(null);
  const abortRef                       = useRef<AbortController | null>(null);

  // Listen for extraction_complete SSE events to update FileReferenceCard status live
  const { lastEvent: sseEvent } = useSse(useMemo(() => ({}), []));
  useEffect(() => {
    if (!sseEvent || sseEvent.type !== 'extraction_complete') return;
    const data = sseEvent.data as { upload_id?: string; status?: string } | undefined;
    if (!data?.upload_id || !data.status) return;
    setMessages((prev) => prev.map((m) =>
      m.role === 'file_upload' && m.uploadId === data.upload_id
        ? { ...m, uploadStatus: data.status }
        : m,
    ));
  }, [sseEvent]);

  const agents = (agentsRes.data?.agents ?? [])
    .sort((a, b) => AGENT_ORDER.indexOf(a.id) - AGENT_ORDER.indexOf(b.id));

  const currentAgent = agents.find((a) => a.id === agentId);
  const providerConfigured = providerRes.data?.configured === true;

  // Load history when switching agents
  useEffect(() => {
    let cancelled = false;

    setIsStreaming(false);
    setShowAll(false);
    abortRef.current?.abort();
    abortRef.current = null;

    if (!client) {
      setMessages([]);
      setConvId(null);
      return;
    }

    void client.getChatHistory(agentId, { limit: 100 }).then((res) => {
      if (cancelled) return;
      if (res.messages.length === 0) {
        setMessages([]);
        setConvId(null);
        return;
      }
      setMessages(res.messages.map((m) => ({
        id:        crypto.randomUUID(),
        role:      m.role,
        content:   m.content,
        timestamp: m.timestamp,
      })));
      setConvId(res.conversation_id);
    }).catch((err: unknown) => {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Chat] Failed to load history for agent ${agentId}:`, msg);
      setMessages([]);
      setConvId(null);
    });

    return () => { cancelled = true; };
  }, [agentId, client]);

  // Cancel stream on unmount
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Inner function that performs the actual send (after scan decision).
  const doSend = useCallback(async (text: string) => {
    if (!client || isStreaming) return;

    const userMsg: Message = {
      id:        crypto.randomUUID(),
      role:      'user',
      content:   text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = crypto.randomUUID();

    try {
      const res = await fetch(`${baseUrl}/api/v1/chat/${agentId}`, {
        method:  'POST',
        headers: client.authHeaders(),
        body:    JSON.stringify({ message: text, ...(convId ? { conversation_id: convId } : {}) }),
        signal:  controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string; error?: string };
        const backendMsg = body.message ?? body.error;
        const errorText = backendMsg
          ? backendMsg
          : `${GUI_ERRORS['GUI-CHAT-001'].message} ${GUI_ERRORS['GUI-CHAT-001'].suggestion}`;
        setMessages((prev) => [...prev, {
          id:        assistantId,
          role:      'assistant',
          content:   errorText,
          timestamp: new Date().toISOString(),
        }]);
        return;
      }

      if (!res.body) {
        setMessages((prev) => [...prev, {
          id:        assistantId,
          role:      'assistant',
          content:   `${GUI_ERRORS['GUI-CHAT-002'].message} ${GUI_ERRORS['GUI-CHAT-002'].suggestion}`,
          timestamp: new Date().toISOString(),
        }]);
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   content = '';

      // Add placeholder streaming message
      setMessages((prev) => [...prev, {
        id:          assistantId,
        role:        'assistant',
        content:     '',
        timestamp:   new Date().toISOString(),
        isStreaming: true,
      }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer      = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          try {
            const evt = JSON.parse(dataStr) as {
              type:        string;
              content?:    string;
              conversation_id?: string;
              error?:      string;
              tool?:       string;
              parameters?: unknown;
              success?:    boolean;
              data?:       unknown;
            };

            if (evt.type === 'start' && evt.conversation_id) {
              setConvId(evt.conversation_id);
            } else if (evt.type === 'token' && evt.content) {
              content += evt.content;
              setMessages((prev) => prev.map((m) =>
                m.id === assistantId ? { ...m, content, isStreaming: true } : m,
              ));
            } else if (evt.type === 'tool_call') {
              const paramsStr = evt.parameters !== undefined
                ? JSON.stringify(evt.parameters).slice(0, 80)
                : '';
              setMessages((prev) => [
                ...prev,
                {
                  id:        crypto.randomUUID(),
                  role:      'tool_call' as const,
                  content:   paramsStr,
                  timestamp: new Date().toISOString(),
                  toolName:  evt.tool || 'unknown',
                },
              ]);
            } else if (evt.type === 'tool_result') {
              setMessages((prev) => [
                ...prev,
                {
                  id:          crypto.randomUUID(),
                  role:        'tool_result' as const,
                  content:     '',
                  timestamp:   new Date().toISOString(),
                  toolName:    evt.tool || 'unknown',
                  toolSuccess: evt.success !== false,
                  toolData:    evt.data ?? null,
                  toolError:   typeof evt.error === 'string' ? evt.error : null,
                },
              ]);
            } else if (evt.type === 'done') {
              setMessages((prev) => prev.map((m) =>
                m.id === assistantId ? { ...m, content: content || m.content, isStreaming: false } : m,
              ));
            } else if (evt.type === 'error') {
              setMessages((prev) => prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: evt.error ?? 'An error occurred.', isStreaming: false }
                  : m,
              ));
            }
          } catch (_jsonErr) {
            // Skip malformed SSE data
          }
        }
      }

      // Finalize in case done event wasn't received
      setMessages((prev) => prev.map((m) =>
        m.id === assistantId && m.isStreaming ? { ...m, isStreaming: false } : m,
      ));

    } catch (err: unknown) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
        || err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        const errMsg = err instanceof Error ? err.message : 'Network error';
        setMessages((prev) => {
          const hasPlaceholder = prev.some((m) => m.id === assistantId);
          const errContent     = `Failed to get response. ${errMsg}`;
          if (hasPlaceholder) {
            return prev.map((m) =>
              m.id === assistantId ? { ...m, content: errContent, isStreaming: false } : m,
            );
          }
          return [...prev, {
            id:        assistantId,
            role:      'assistant',
            content:   errContent,
            timestamp: new Date().toISOString(),
          }];
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [client, baseUrl, agentId, convId, isStreaming]);

  // Outer handleSend: runs bouncer scan first, then either proceeds or shows dialog.
  const handleSend = useCallback(async (text: string) => {
    if (!client || isStreaming) return;

    // Attempt bouncer scan; fail-open on any error (scan is advisory, not blocking)
    let scanResult: ScanResult | null = null;
    try {
      const result = await client.scanMessage(text);
      if (result.detected) {
        scanResult = result;
      }
    } catch (_scanErr: unknown) {
      // Network error or auth issue — proceed without scan
    }

    if (scanResult !== null) {
      // Show redaction dialog — pause the send
      setPendingScan({ scanResult, originalMessage: text });
      return;
    }

    // No sensitive data detected — send directly
    await doSend(text);
  }, [client, isStreaming, doSend]);

  async function handleApply() {
    if (!client || applyState === 'running') return;
    setApplyState('running');
    try {
      await client.triggerApply();
      setApplyState('success');
    } catch (_err: unknown) {
      setApplyState('error');
    }
    // Reset badge after 3 s
    setTimeout(() => setApplyState('idle'), 3000);
  }

  if (!client) {
    return (
      <div className="page-chat--not-connected">
        <strong>{t('gui.chat.not_connected_title')}</strong>{' '}
        <button
          onClick={() => navigate('/settings')}
          className="page-chat--link-btn"
        >
          {t('gui.chat.open_settings')}
        </button>{' '}
        {t('gui.chat.enter_server_details')}
      </div>
    );
  }

  if (agentsRes.loading) {
    return (
      <div className="page-chat--loading">
        <LoadingSpinner label="Loading agents…" />
      </div>
    );
  }

  if (!currentAgent) {
    return (
      <div className="page-chat--not-found">
        <p>{t('gui.chat.agent_not_found', { agentId })}</p>
        <button
          onClick={() => navigate('/agents')}
          className="page-chat--link-btn"
        >
          {t('gui.chat.back_to_agents')}
        </button>
      </div>
    );
  }

  const inputDisabled     = !providerConfigured;
  const inputDisabledMsg  = !providerConfigured
    ? 'Configure an LLM provider in Settings to start chatting.'
    : undefined;

  return (
    <>
      {/* Bouncer redaction dialog — rendered above chat when scan finds sensitive data */}
      {pendingScan !== null && (
        <RedactionDialog
          scanResult={pendingScan.scanResult}
          originalMessage={pendingScan.originalMessage}
          onSend={(msg) => {
            setPendingScan(null);
            void doSend(msg);
          }}
          onCancel={() => setPendingScan(null)}
        />
      )}

    <div className="page-chat--container">
      {/* No-provider banner */}
      {!providerConfigured && !providerRes.loading && (
        <div style={{
          background:  'var(--color-info-bg)',
          border:      'none',
          borderBottom: '1px solid var(--color-info-border)',
          padding:     '10px 16px',
          fontSize:    '15px',
          color:       'var(--color-info)',
          display:     'flex',
          alignItems:  'center',
          gap:         '8px',
          flexShrink:  0,
        }}>
          <span>⚠</span>
          <span>
            Set up an LLM provider in{' '}
            <button
              onClick={() => navigate('/settings')}
              className="page-chat--info-link"
            >
              Settings
            </button>
            {' '}to start chatting.
          </span>
        </div>
      )}

      {/* Agent switcher */}
      <AgentSwitcher
        agents={agents}
        currentId={agentId}
        providerConfigured={providerConfigured}
      />

      {/* Chat header */}
      <ChatHeader
        agent={currentAgent}
        onApply={() => { void handleApply(); }}
        applyState={applyState}
        onBack={() => navigate('/agents')}
        showApply={agentId === 'hr'}
      />

      {/* Messages */}
      <ChatMessages
        messages={messages}
        isStreaming={isStreaming}
        agentName={currentAgent.name}
        providerConfigured={providerConfigured}
        showAll={showAll}
        onShowAll={() => setShowAll(true)}
      />

      {/* Input */}
      <ChatUploadZone
        agentId={agentId}
        conversationId={convId ?? undefined}
        baseUrl={baseUrl}
        authHeaders={() => client ? client.authHeaders() : {}}
        onUploadComplete={(upload) => {
          setMessages((prev) => [
            ...prev,
            {
              id:              crypto.randomUUID(),
              role:            'file_upload' as const,
              content:         '',
              timestamp:       new Date().toISOString(),
              uploadId:        upload.upload_id,
              uploadFilename:  upload.filename,
              uploadSize:      upload.size_bytes,
              uploadMimetype:  upload.mimetype,
              uploadStatus:    upload.extraction_status,
            },
          ]);
        }}
        disabled={inputDisabled || isStreaming}
      >
        <ChatInput
          onSend={(msg) => { void handleSend(msg); }}
          disabled={inputDisabled || isStreaming}
          disabledReason={inputDisabledMsg}
        />
      </ChatUploadZone>
    </div>
    </>
  );
}

