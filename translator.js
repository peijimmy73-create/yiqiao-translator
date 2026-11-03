(function attachTranslationClient(root, factory) {
  const client = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = client;
  }
  root.TranslationClient = client;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createClient() {
  'use strict';

  const LANGUAGES = Object.freeze({
    auto: { name: '自动检测', code: null },
    zh: { name: '简体中文', code: 'zh-CN' },
    en: { name: '英语', code: 'en-US' },
    ja: { name: '日语', code: 'ja-JP' },
    ko: { name: '韩语', code: 'ko-KR' },
    fr: { name: '法语', code: 'fr-FR' },
    de: { name: '德语', code: 'de-DE' },
    es: { name: '西班牙语', code: 'es-ES' },
  });

  const MAX_CHARACTERS = 5000;
  const MAX_CHUNK_BYTES = 420;
  const REQUEST_TIMEOUT_MS = 15_000;
  const encoder = new TextEncoder();

  class TranslationError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'TranslationError';
      this.code = code || 'TRANSLATION_FAILED';
    }
  }

  function isSupportedLanguage(code, allowAuto) {
    return Object.prototype.hasOwnProperty.call(LANGUAGES, code) &&
      (allowAuto || code !== 'auto');
  }

  function detectLanguage(text) {
    if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/u.test(text)) return 'ko';
    if (/[\u4e00-\u9fff]/u.test(text)) return 'zh';
    return 'en';
  }

  function utf8Length(text) {
    return encoder.encode(text).length;
  }

  function splitAtByteLimit(text, maxBytes) {
    const pieces = [];
    let current = '';
    let bytes = 0;

    for (const character of Array.from(text)) {
      const characterBytes = encoder.encode(character).length;
      if (current && bytes + characterBytes > maxBytes) {
        pieces.push(current);
        current = '';
        bytes = 0;
      }
      current += character;
      bytes += characterBytes;
    }
    if (current) pieces.push(current);
    return pieces;
  }

  function chunkText(text, maxBytes) {
    const limit = maxBytes || MAX_CHUNK_BYTES;
    const sentences = text.split(/(?<=[。！？.!?；;\n])/u);
    const chunks = [];
    let current = '';
    let currentBytes = 0;

    for (const sentence of sentences) {
      const parts =
        utf8Length(sentence) <= limit
          ? [sentence]
          : splitAtByteLimit(sentence, limit);

      for (const part of parts) {
        const partBytes = utf8Length(part);
        if (current && currentBytes + partBytes > limit) {
          chunks.push(current);
          current = '';
          currentBytes = 0;
        }
        current += part;
        currentBytes += partBytes;
      }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [text];
  }

  function decodeHtmlEntities(value) {
    const entities = {
      '&amp;': '&',
      '&quot;': '"',
      '&#39;': "'",
      '&apos;': "'",
      '&lt;': '<',
      '&gt;': '>',
    };
    return value
      .replace(/&(amp|quot|#39|apos|lt|gt);/g, (entity) => entities[entity])
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
        String.fromCodePoint(Number.parseInt(code, 16)),
      );
  }

  function countMatches(text, pattern) {
    return (text.match(pattern) || []).length;
  }

  function scriptScore(text, target) {
    const han = countMatches(text, /[\u3400-\u9fff]/gu);
    const kana = countMatches(text, /[\u3040-\u30ff]/gu);
    const hangul = countMatches(text, /[\uac00-\ud7af]/gu);
    const latin = countMatches(text, /[A-Za-zÀ-ÖØ-öø-ÿ]/gu);
    const visible = Math.max(han + kana + hangul + latin, 1);

    if (target === 'zh') {
      return han ? 4 + (han / visible) * 4 : 0;
    }
    if (target === 'ja') {
      return kana ? 5 + (kana / visible) * 3 : han ? 2 : 0;
    }
    if (target === 'ko') {
      return hangul ? 5 + (hangul / visible) * 3 : 0;
    }
    if (target === 'en' || target === 'fr' || target === 'de' || target === 'es') {
      return latin && !han && !kana && !hangul ? 5 : 0;
    }
    return 0;
  }

  function normalizeForComparison(text) {
    return String(text)
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  function extractBestTranslation(data, source, target, original) {
    const candidates = [];
    const seen = new Set();
    const primary = data?.responseData?.translatedText;

    function addCandidate(translation, meta) {
      if (typeof translation !== 'string') return;
      const cleaned = decodeHtmlEntities(translation)
        .replace(/MYMEMORY WARNING.*$/i, '')
        .trim();
      if (!cleaned || seen.has(cleaned)) return;
      seen.add(cleaned);
      candidates.push({ text: cleaned, ...meta });
    }

    addCandidate(primary, {
      match: Number(data?.responseData?.match) || 0,
      quality: 0,
      usage: 0,
      machine: false,
    });

    // MyMemory exposes its neural result as responseData and user-contributed
    // matches separately. Prefer the full neural result when it is written in
    // the expected target script; partial translation memories often omit the
    // end of the sentence or translate only one ambiguous phrase.
    const primaryText = candidates[0]?.text;
    if (primaryText && scriptScore(primaryText, target) > 0) {
      return applyTermCorrections(primaryText, target);
    }

    for (const match of Array.isArray(data?.matches) ? data.matches : []) {
      addCandidate(match.translation, {
        match: Number(match.match) || 0,
        quality: Number(match.quality) || 0,
        usage: Number(match['usage-count']) || 0,
        machine:
          match['created-by'] === 'MT!' ||
          /machine translation/i.test(String(match.reference || '')),
      });
    }

    if (!candidates.length) {
      throw new TranslationError('在线翻译返回了空白结果。', 'EMPTY_PROVIDER_RESULT');
    }

    const normalizedOriginal = normalizeForComparison(original);
    for (const candidate of candidates) {
      const script = scriptScore(candidate.text, target);
      const sourceEcho =
        normalizeForComparison(candidate.text) === normalizedOriginal;
      candidate.score =
        script * 10 +
        candidate.match * 50 +
        Math.min(candidate.quality, 100) / 20 +
        Math.min(candidate.usage, 5) / 10 +
        (candidate.machine ? 2 : 0) -
        (sourceEcho ? 30 : 0);
    }

    candidates.sort((a, b) => b.score - a.score);
    return applyTermCorrections(candidates[0].text, target);
  }

  function applyTermCorrections(text, target) {
    if (target !== 'zh') return text;
    return text
      .replace(/入场要求/gu, '入学要求')
      .replace(/入场条件/gu, '入学条件')
      .replace(/入场办公室/gu, '招生办公室');
  }

  async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new TranslationError('在线翻译请求超时，请检查网络后重试。', 'TIMEOUT');
      }
      throw new TranslationError(
        '无法连接在线翻译服务。请确认电脑可以上网，并使用最新版 Chrome 或 Edge 打开本软件。',
        'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function translateChunk(text, source, target) {
    const endpoint = new URL('https://api.mymemory.translated.net/get');
    endpoint.searchParams.set('q', text);
    endpoint.searchParams.set(
      'langpair',
      `${LANGUAGES[source].code}|${LANGUAGES[target].code}`,
    );

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout(endpoint.toString());
        if (!response.ok) {
          throw new TranslationError(
            `在线翻译服务返回错误（HTTP ${response.status}）。`,
            'PROVIDER_HTTP_ERROR',
          );
        }

        let data;
        try {
          data = await response.json();
        } catch {
          throw new TranslationError(
            '在线翻译服务返回了无法识别的数据，请稍后重试。',
            'INVALID_PROVIDER_RESPONSE',
          );
        }
        const status = Number(data?.responseStatus);
        if (status !== 200) {
          throw new TranslationError(
            data?.responseDetails ||
              '在线翻译服务暂时繁忙，请稍后再试。',
            'PROVIDER_BUSY',
          );
        }
        return extractBestTranslation(data, source, target, text);
      } catch (error) {
        lastError = error;
        const retryable =
          error?.code === 'NETWORK_ERROR' ||
          error?.code === 'TIMEOUT' ||
          error?.code === 'PROVIDER_HTTP_ERROR';
        if (!retryable || attempt === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    throw lastError || new TranslationError('翻译失败，请稍后重试。');
  }

  async function translate(options) {
    const text = String(options?.text || '').trim();
    const source = options?.source || 'auto';
    const target = options?.target || 'zh';

    if (!text) {
      throw new TranslationError('请输入需要翻译的内容。', 'EMPTY_TEXT');
    }
    if (Array.from(text).length > MAX_CHARACTERS) {
      throw new TranslationError(
        `单次最多翻译 ${MAX_CHARACTERS} 个字符，请分段翻译。`,
        'TEXT_TOO_LONG',
      );
    }
    if (!isSupportedLanguage(source, true)) {
      throw new TranslationError('不支持该源语言。', 'UNSUPPORTED_SOURCE');
    }
    if (!isSupportedLanguage(target, false)) {
      throw new TranslationError('不支持该目标语言。', 'UNSUPPORTED_TARGET');
    }

    const detectedSource = source === 'auto' ? detectLanguage(text) : source;
    if (detectedSource === target) {
      return {
        text,
        source,
        detectedSource,
        target,
        provider: '原文',
        warnings: ['源语言与目标语言相同，已保留原文。'],
      };
    }

    const chunks = chunkText(text);
    const translated = [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (typeof options.onProgress === 'function') {
        options.onProgress(index + 1, chunks.length);
      }
      const chunk = chunks[index];
      const result = await translateChunk(
        chunk,
        detectedSource,
        target,
      );
      translated.push({
        text: result,
        newline: /\n\s*$/u.test(chunk),
      });
    }

    return {
      text: translated
        .map((part, index) => {
          if (index === translated.length - 1) return part.text;
          return `${part.text}${part.newline ? '\n' : ' '}`;
        })
        .join(''),
      source,
      detectedSource,
      target,
      provider: 'MyMemory 在线机器翻译',
      warnings: [],
    };
  }

  return {
    LANGUAGES,
    MAX_CHARACTERS,
    TranslationError,
    chunkText,
    decodeHtmlEntities,
    detectLanguage,
    extractBestTranslation,
    translate,
    utf8Length,
  };
});
