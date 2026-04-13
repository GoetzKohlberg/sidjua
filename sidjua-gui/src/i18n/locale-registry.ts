// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 SIDJUA. All rights reserved.

/**
 * Authoritative locale registry for all 44 SIDJUA locales.
 *
 * Single source of truth for:
 *   - English name (for display in non-native contexts)
 *   - Native name (shown in the language picker)
 *   - Region group (for picker grouping)
 *   - aiGenerated flag (shown as "AI" badge in picker)
 *
 * human-maintained: en, de
 * AI-generated (stub translations): all others — PM1 fills via LLM
 */

export interface LocaleMeta {
  name:        string;   // English name
  nativeName:  string;   // Native name
  region:      string;   // Region group for UI
  aiGenerated: boolean;
}

export const LOCALE_REGISTRY: Record<string, LocaleMeta> = {
  // ── Americas ──────────────────────────────────────────────────────────────
  en:      { name: 'English',               nativeName: 'English',              region: 'Americas',    aiGenerated: false },
  es:      { name: 'Spanish',               nativeName: 'Español',              region: 'Americas',    aiGenerated: true  },
  'pt-BR': { name: 'Portuguese (Brazil)',   nativeName: 'Português (Brasil)',   region: 'Americas',    aiGenerated: true  },

  // ── Europe ────────────────────────────────────────────────────────────────
  de:      { name: 'German',                nativeName: 'Deutsch',              region: 'Europe',      aiGenerated: false },
  fr:      { name: 'French',                nativeName: 'Français',             region: 'Europe',      aiGenerated: true  },
  it:      { name: 'Italian',               nativeName: 'Italiano',             region: 'Europe',      aiGenerated: true  },
  nl:      { name: 'Dutch',                 nativeName: 'Nederlands',           region: 'Europe',      aiGenerated: true  },
  pl:      { name: 'Polish',                nativeName: 'Polski',               region: 'Europe',      aiGenerated: true  },
  cs:      { name: 'Czech',                 nativeName: 'Čeština',              region: 'Europe',      aiGenerated: true  },
  ro:      { name: 'Romanian',              nativeName: 'Română',               region: 'Europe',      aiGenerated: true  },
  ru:      { name: 'Russian',               nativeName: 'Русский',              region: 'Europe',      aiGenerated: true  },
  uk:      { name: 'Ukrainian',             nativeName: 'Українська',           region: 'Europe',      aiGenerated: true  },
  sv:      { name: 'Swedish',               nativeName: 'Svenska',              region: 'Europe',      aiGenerated: true  },
  da:      { name: 'Danish',                nativeName: 'Dansk',                region: 'Europe',      aiGenerated: true  },
  no:      { name: 'Norwegian',             nativeName: 'Norsk',                region: 'Europe',      aiGenerated: true  },
  fi:      { name: 'Finnish',               nativeName: 'Suomi',                region: 'Europe',      aiGenerated: true  },
  bg:      { name: 'Bulgarian',             nativeName: 'Български',            region: 'Europe',      aiGenerated: true  },
  hr:      { name: 'Croatian',              nativeName: 'Hrvatski',             region: 'Europe',      aiGenerated: true  },
  sk:      { name: 'Slovak',                nativeName: 'Slovenčina',           region: 'Europe',      aiGenerated: true  },
  sl:      { name: 'Slovenian',             nativeName: 'Slovenščina',          region: 'Europe',      aiGenerated: true  },
  hu:      { name: 'Hungarian',             nativeName: 'Magyar',               region: 'Europe',      aiGenerated: true  },
  et:      { name: 'Estonian',              nativeName: 'Eesti',                region: 'Europe',      aiGenerated: true  },
  tr:      { name: 'Turkish',               nativeName: 'Türkçe',               region: 'Europe',      aiGenerated: true  },
  el:      { name: 'Greek',                 nativeName: 'Ελληνικά',             region: 'Europe',      aiGenerated: true  },
  ga:      { name: 'Irish',                 nativeName: 'Gaeilge',              region: 'Europe',      aiGenerated: true  },

  // ── Middle East ────────────────────────────────────────────────────────────
  ar:      { name: 'Arabic',                nativeName: 'العربية',              region: 'Middle East', aiGenerated: true  },
  ur:      { name: 'Urdu',                  nativeName: 'اردو',                 region: 'Middle East', aiGenerated: true  },

  // ── Asia ──────────────────────────────────────────────────────────────────
  hi:      { name: 'Hindi',                 nativeName: 'हिन्दी',                region: 'Asia',        aiGenerated: true  },
  bn:      { name: 'Bengali',               nativeName: 'বাংলা',                region: 'Asia',        aiGenerated: true  },
  mr:      { name: 'Marathi',               nativeName: 'मराठी',                region: 'Asia',        aiGenerated: true  },
  ta:      { name: 'Tamil',                 nativeName: 'தமிழ்',                region: 'Asia',        aiGenerated: true  },
  te:      { name: 'Telugu',                nativeName: 'తెలుగు',               region: 'Asia',        aiGenerated: true  },
  fil:     { name: 'Filipino',              nativeName: 'Filipino',             region: 'Asia',        aiGenerated: true  },
  id:      { name: 'Indonesian',            nativeName: 'Bahasa Indonesia',     region: 'Asia',        aiGenerated: true  },
  ms:      { name: 'Malay',                 nativeName: 'Bahasa Melayu',        region: 'Asia',        aiGenerated: true  },
  th:      { name: 'Thai',                  nativeName: 'ไทย',                  region: 'Asia',        aiGenerated: true  },
  vi:      { name: 'Vietnamese',            nativeName: 'Tiếng Việt',           region: 'Asia',        aiGenerated: true  },
  ja:      { name: 'Japanese',              nativeName: '日本語',                region: 'Asia',        aiGenerated: true  },
  ko:      { name: 'Korean',                nativeName: '한국어',                region: 'Asia',        aiGenerated: true  },
  'zh-CN': { name: 'Chinese (Simplified)',  nativeName: '简体中文',              region: 'Asia',        aiGenerated: true  },
  'zh-TW': { name: 'Chinese (Traditional)', nativeName: '繁體中文',             region: 'Asia',        aiGenerated: true  },

  // ── Africa ────────────────────────────────────────────────────────────────
  ha:      { name: 'Hausa',                 nativeName: 'Hausa',                region: 'Africa',      aiGenerated: true  },
  sw:      { name: 'Swahili',               nativeName: 'Kiswahili',            region: 'Africa',      aiGenerated: true  },
  pcm:     { name: 'Nigerian Pidgin',       nativeName: 'Naijá',                region: 'Africa',      aiGenerated: true  },
};

export const REGION_ORDER = ['Americas', 'Europe', 'Middle East', 'Asia', 'Africa'];
