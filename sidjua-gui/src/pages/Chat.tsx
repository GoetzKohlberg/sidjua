// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Götz Kohlberg. All rights reserved.
// Dual licensed: AGPL-3.0 + SIDJUA Commercial License. See LICENSE.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { ArrowLeft, Play } from 'lucide-react';

import { useAppConfig }  from '../lib/config';
import { useApi }        from '../hooks/useApi';
import { AgentIcon }     from '../components/shared/AgentIcon';
import { LoadingSpinner } from '../components/shared/LoadingSpinner';
import type { StarterAgentsResponse, ProviderConfigResponse } from '../api/types';
import { GUI_ERRORS } from '../i18n/gui-errors';
import { ChatUploadZone, PaperclipButton } from '../components/chat/ChatUploadZone';
import { FileReferenceCard }               from '../components/chat/FileReferenceCard';


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
    <div style={{
      display:    'flex',
      gap:        '4px',
      padding:    '8px 16px',
      borderBottom: '1px solid var(--color-border)',
      background: 'var(--color-surface-alt)',
      overflowX:  'auto',
      flexShrink: 0,
    }}>
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
              fontSize:       '12px',
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
  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:          '12px',
      padding:      '12px 16px',
      borderBottom: '1px solid var(--color-border)',
      background:   'var(--color-surface)',
      flexShrink:   0,
    }}>
      <button
        onClick={onBack}
        aria-label="Back to Agents"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center',
          padding: '4px',
        }}
      >
        <ArrowLeft size={16} />
      </button>

      <div style={{
        width: '36px', height: '36px', borderRadius: '50%',
        background: 'var(--color-accent-muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--color-accent)', flexShrink: 0,
      }}>
        <AgentIcon name={agent.icon} size={16} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--color-text)' }}>
          {agent.name}
        </div>
        <div style={{
          fontSize: '11px', color: 'var(--color-text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {agent.description}
        </div>
      </div>

      {showApply && <button
        onClick={onApply}
        disabled={applyState === 'running'}
        aria-label="Apply configuration"
        title="Apply configuration"
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
          fontSize:     '12px',
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
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '8px' }}>
      <div style={{
        maxWidth:     '80%',
        padding:      '8px 12px',
        borderRadius: 'var(--radius-md)',
        background:   'var(--color-surface-alt, #f3f4f6)',
        border:       '1px solid var(--color-border)',
        fontSize:     '12px',
        color:        'var(--color-text-muted)',
        fontFamily:   'monospace',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
          <span style={{ fontSize: '10px', opacity: 0.7 }}>⚙</span>
          <strong style={{ color: 'var(--color-text-secondary)' }}>
            Calling tool: {message.toolName ?? message.content}
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
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '8px' }}>
      <div style={{
        maxWidth:     '80%',
        padding:      '8px 12px',
        borderRadius: 'var(--radius-md)',
        background:   success ? 'var(--color-success-bg, #f0fdf4)' : 'var(--color-danger-bg, #fef2f2)',
        border:       `1px solid ${success ? 'var(--color-success-border, #bbf7d0)' : 'var(--color-danger-border, #fecaca)'}`,
        fontSize:     '12px',
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
          fontSize:     '14px',
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
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '12px' }}>
      <div style={{
        padding:      '12px 16px',
        borderRadius: '16px 16px 16px 4px',
        background:   'var(--color-surface-alt, #f3f4f6)',
        border:       '1px solid var(--color-border)',
        display:      'flex',
        gap:          '4px',
        alignItems:   'center',
      }}>
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const hiddenCount     = showAll ? 0 : Math.max(0, messages.length - VISIBLE_LIMIT);
  const visibleMessages = showAll ? messages : messages.slice(-VISIBLE_LIMIT);

  return (
    <div style={{
      flex:      1,
      overflowY: 'auto',
      padding:   '16px',
    }}>
      {messages.length === 0 && !isStreaming && (
        <div style={{
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          height:         '100%',
          color:          'var(--color-text-muted)',
          fontSize:       '13px',
          textAlign:      'center',
          gap:            '8px',
        }}>
          <span style={{ fontSize: '32px', opacity: 0.4 }}>💬</span>
          <p style={{ margin: 0 }}>
            {providerConfigured ? (<>Start a conversation with <strong>{agentName}</strong>.<br /></>) : (<>No LLM provider configured.<br />Please set one up in <strong>Settings → LLM Providers</strong> first.<br /></>)}
            Type a message below.
          </p>
        </div>
      )}

      {hiddenCount > 0 && (
        <div style={{ textAlign: 'center', marginBottom: '12px' }}>
          <button
            onClick={onShowAll}
            style={{
              background:   'none',
              border:       '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color:        'var(--color-text-muted)',
              cursor:       'pointer',
              fontSize:     '12px',
              padding:      '5px 12px',
            }}
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
    <div style={{
      padding:      '12px 16px',
      borderTop:    '1px solid var(--color-border)',
      background:   'var(--color-surface)',
      flexShrink:   0,
    }}>
      {disabledReason && (
        <div style={{
          fontSize:     '12px',
          color:        'var(--color-text-muted)',
          marginBottom: '8px',
          textAlign:    'center',
        }}>
          {disabledReason}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
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
            fontSize:    '14px',
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
          aria-label="Send message"
          style={{
            padding:      '10px 16px',
            borderRadius: 'var(--radius-md)',
            border:       'none',
            background:   disabled || value.trim() === '' ? 'var(--color-border)' : 'var(--color-accent)',
            color:        disabled || value.trim() === '' ? 'var(--color-text-muted)' : 'var(--color-on-accent)',
            cursor:       disabled || value.trim() === '' ? 'not-allowed' : 'pointer',
            fontSize:     '13px',
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
      <div style={{
        textAlign:  'center',
        fontSize:   '11px',
        color:      'var(--color-text-muted)',
        padding:    '4px 0 0 0',
        lineHeight: 1.3,
      }}>
        SIDJUA agents use AI models that can make mistakes. Please verify important information.
        <span style={{ display: 'block', fontSize: '10px', opacity: 0.7, marginTop: '2px' }}>
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

  const agentsRes   = useApi<StarterAgentsResponse>((c) => c.listStarterAgents());
  const providerRes = useApi<ProviderConfigResponse>((c) => c.getProviderConfig());

  const [messages,    setMessages]    = useState<Message[]>([]);
  const [isStreaming, setIsStreaming]  = useState(false);
  const [convId,      setConvId]      = useState<string | null>(null);
  const [showAll,     setShowAll]     = useState(false);
  const [applyState,  setApplyState]  = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const abortRef                      = useRef<AbortController | null>(null);

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

  const handleSend = useCallback(async (text: string) => {
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
      <div style={{
        padding:      '24px',
        background:   'var(--color-warning-bg)',
        border:       '1px solid var(--color-warning)',
        borderRadius: 'var(--radius-lg)',
        color:        'var(--color-warning)',
        fontSize:     '13px',
      }}>
        <strong>{GUI_ERRORS['GUI-CONN-005'].message}</strong>{' '}
        <button
          onClick={() => navigate('/settings')}
          style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit' }}
        >
          Open Settings
        </button>{' '}
        to enter your server URL and API key.
      </div>
    );
  }

  if (agentsRes.loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
        <LoadingSpinner label="Loading agents…" />
      </div>
    );
  }

  if (!currentAgent) {
    return (
      <div style={{
        padding:      '24px',
        background:   'var(--color-surface)',
        border:       '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        fontSize:     '13px',
        color:        'var(--color-text)',
      }}>
        <p>Agent <strong>{agentId}</strong> not found.</p>
        <button
          onClick={() => navigate('/agents')}
          style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit', padding: 0 }}
        >
          Back to Agents
        </button>
      </div>
    );
  }

  const inputDisabled     = !providerConfigured;
  const inputDisabledMsg  = !providerConfigured
    ? 'Configure an LLM provider in Settings to start chatting.'
    : undefined;

  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      height:        'calc(100vh - var(--header-height, 56px) - 96px)',
      background:    'var(--color-surface)',
      border:        '1px solid var(--color-border)',
      borderRadius:  'var(--radius-lg)',
      overflow:      'hidden',
      boxShadow:     'var(--shadow-sm)',
    }}>
      {/* No-provider banner */}
      {!providerConfigured && !providerRes.loading && (
        <div style={{
          background:  'var(--color-info-bg)',
          border:      'none',
          borderBottom: '1px solid var(--color-info-border)',
          padding:     '10px 16px',
          fontSize:    '13px',
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
              style={{ background: 'none', border: 'none', color: 'var(--color-info)', cursor: 'pointer', textDecoration: 'underline', fontSize: 'inherit', padding: 0 }}
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
  );
}

export default Chat;
