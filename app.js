'use strict';

const LANGUAGE_NAMES = Object.freeze({
  auto: '自动检测',
  zh: '简体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
});

const SPEECH_LOCALES = Object.freeze({
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
});

const SAMPLES = Object.freeze([
  {
    text: 'This software can translate arbitrary English sentences into Chinese.',
    source: 'en',
    target: 'zh',
  },
  {
    text: 'The research project will begin next Monday.',
    source: 'en',
    target: 'zh',
  },
  {
    text: '我正在准备研究生申请。',
    source: 'zh',
    target: 'en',
  },
]);

const HISTORY_KEY = 'yiqiao-portable-history-v1';
const PREFERENCES_KEY = 'yiqiao-portable-preferences-v1';
const MAX_HISTORY = 100;

const elements = {
  serviceState: document.querySelector('#serviceState'),
  serviceLabel: document.querySelector('#serviceLabel'),
  modeLabel: document.querySelector('#modeLabel'),
  sourceLanguage: document.querySelector('#sourceLanguage'),
  targetLanguage: document.querySelector('#targetLanguage'),
  swapLanguages: document.querySelector('#swapLanguages'),
  sourceText: document.querySelector('#sourceText'),
  characterCount: document.querySelector('#characterCount'),
  loadSample: document.querySelector('#loadSample'),
  clearText: document.querySelector('#clearText'),
  saveHistory: document.querySelector('#saveHistory'),
  translateButton: document.querySelector('#translateButton'),
  resultPlaceholder: document.querySelector('#resultPlaceholder'),
  translatedText: document.querySelector('#translatedText'),
  translationError: document.querySelector('#translationError'),
  translationMeta: document.querySelector('#translationMeta'),
  warningBar: document.querySelector('#warningBar'),
  warningText: document.querySelector('#warningText'),
  copyResult: document.querySelector('#copyResult'),
  speakResult: document.querySelector('#speakResult'),
  historyList: document.querySelector('#historyList'),
  historySearch: document.querySelector('#historySearch'),
  exportHistory: document.querySelector('#exportHistory'),
  clearHistory: document.querySelector('#clearHistory'),
  toast: document.querySelector('#toast'),
  resultPane: document.querySelector('#resultPane'),
  workspace: document.querySelector('#workspace'),
};

const state = {
  translating: false,
  currentTranslation: null,
  sampleIndex: 0,
  historyEntries: [],
  toastTimer: null,
  searchTimer: null,
};

function safeReadStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function restorePreferences() {
  const saved = safeReadStorage(PREFERENCES_KEY, {});
  if (Object.hasOwn(LANGUAGE_NAMES, saved.source)) {
    elements.sourceLanguage.value = saved.source;
  }
  if (
    Object.hasOwn(LANGUAGE_NAMES, saved.target) &&
    saved.target !== 'auto'
  ) {
    elements.targetLanguage.value = saved.target;
  }
  if (typeof saved.saveHistory === 'boolean') {
    elements.saveHistory.checked = saved.saveHistory;
  }
}

function savePreferences() {
  safeWriteStorage(PREFERENCES_KEY, {
    source: elements.sourceLanguage.value,
    target: elements.targetLanguage.value,
    saveHistory: elements.saveHistory.checked,
  });
}

function refreshOnlineState() {
  const online = navigator.onLine;
  elements.serviceState.classList.toggle('is-ready', online);
  elements.serviceState.classList.toggle('is-error', !online);
  elements.serviceLabel.textContent = online
    ? '在线翻译已就绪'
    : '当前离线';
  elements.modeLabel.textContent = online ? '实时在线' : '无法联网';
}

function updateCharacterCount() {
  const length = Array.from(elements.sourceText.value).length;
  elements.characterCount.textContent = `${length} / 5000`;
  elements.characterCount.classList.toggle('is-near-limit', length >= 4800);
}

function setTranslating(isTranslating) {
  state.translating = isTranslating;
  elements.translateButton.disabled = isTranslating;
  elements.translateButton.classList.toggle('is-loading', isTranslating);
  elements.resultPane.setAttribute('aria-busy', String(isTranslating));
  elements.translateButton.querySelector('.button-label').textContent =
    isTranslating ? '正在翻译' : '开始翻译';
}

function hideTranslationFeedback() {
  elements.translationError.hidden = true;
  elements.translationError.textContent = '';
  elements.warningBar.hidden = true;
  elements.warningText.textContent = '';
}

function showPlaceholder() {
  elements.resultPlaceholder.hidden = false;
  elements.translatedText.hidden = true;
  elements.translationError.hidden = true;
  elements.translatedText.textContent = '';
  elements.copyResult.disabled = true;
  elements.speakResult.disabled = true;
}

function showTranslation(result) {
  state.currentTranslation = {
    text: elements.sourceText.value.trim(),
    result,
  };
  elements.resultPlaceholder.hidden = true;
  elements.translationError.hidden = true;
  elements.translatedText.hidden = false;
  elements.translatedText.textContent = result.text;
  elements.copyResult.disabled = false;
  elements.speakResult.disabled = false;

  elements.translationMeta.replaceChildren();
  const provider = document.createElement('span');
  provider.className = 'provider-badge';
  provider.textContent = result.provider || '在线翻译';

  const language = document.createElement('span');
  language.className = 'language-badge';
  language.textContent = `${
    LANGUAGE_NAMES[result.detectedSource] || result.detectedSource
  } → ${LANGUAGE_NAMES[result.target] || result.target}`;

  elements.translationMeta.append(provider, language);
  if (result.warnings?.length) {
    elements.warningText.textContent = result.warnings.join(' ');
    elements.warningBar.hidden = false;
  } else {
    elements.warningBar.hidden = true;
  }
}

function showTranslationError(message) {
  state.currentTranslation = null;
  elements.resultPlaceholder.hidden = true;
  elements.translatedText.hidden = true;
  elements.translationError.hidden = false;
  elements.translationError.textContent = message;
  elements.copyResult.disabled = true;
  elements.speakResult.disabled = true;
  elements.translationMeta.replaceChildren();
  const status = document.createElement('span');
  status.textContent = '翻译未完成';
  elements.translationMeta.append(status);
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.remove('is-visible');
  }, 2400);
}

function createHistoryEntry(result) {
  const randomId =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: randomId,
    text: elements.sourceText.value.trim(),
    translation: result.text,
    source: elements.sourceLanguage.value,
    detectedSource: result.detectedSource,
    target: elements.targetLanguage.value,
    provider: result.provider,
    createdAt: new Date().toISOString(),
  };
}

function loadHistory() {
  const saved = safeReadStorage(HISTORY_KEY, []);
  state.historyEntries = Array.isArray(saved)
    ? saved.slice(0, MAX_HISTORY)
    : [];
  renderHistory();
}

function persistHistory() {
  if (!safeWriteStorage(HISTORY_KEY, state.historyEntries)) {
    showToast('浏览器禁止本地存储，本次历史无法保存');
  }
}

function addHistory(result) {
  state.historyEntries.unshift(createHistoryEntry(result));
  state.historyEntries = state.historyEntries.slice(0, MAX_HISTORY);
  persistHistory();
  renderHistory();
}

function filteredHistory() {
  const keyword = elements.historySearch.value.trim().toLocaleLowerCase();
  if (!keyword) return state.historyEntries;
  return state.historyEntries.filter((entry) =>
    `${entry.text} ${entry.translation}`
      .toLocaleLowerCase()
      .includes(keyword),
  );
}

function createHistoryItem(entry) {
  const item = document.createElement('div');
  item.className = 'history-item';

  const main = document.createElement('button');
  main.className = 'history-main';
  main.type = 'button';
  main.title = `恢复：${entry.text}`;
  const source = document.createElement('strong');
  source.textContent = entry.text;
  const translated = document.createElement('span');
  translated.textContent = entry.translation;
  main.append(source, translated);
  main.addEventListener('click', () => restoreHistory(entry));

  const remove = document.createElement('button');
  remove.className = 'history-delete';
  remove.type = 'button';
  remove.title = '删除这条记录';
  remove.setAttribute('aria-label', '删除这条历史记录');
  remove.addEventListener('click', () => {
    state.historyEntries = state.historyEntries.filter(
      (candidate) => candidate.id !== entry.id,
    );
    persistHistory();
    renderHistory();
    showToast('已删除这条记录');
  });

  item.append(main, remove);
  return item;
}

function renderHistory() {
  const entries = filteredHistory();
  elements.historyList.replaceChildren();

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    const title = document.createElement('p');
    title.textContent = elements.historySearch.value
      ? '没有匹配记录'
      : '还没有记录';
    const description = document.createElement('span');
    description.textContent = elements.historySearch.value
      ? '可以换一个关键词再试试。'
      : '完成第一次翻译后，会保存在当前浏览器。';
    empty.append(title, description);
    elements.historyList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.slice(0, 12).forEach((entry) => {
    fragment.append(createHistoryItem(entry));
  });
  elements.historyList.append(fragment);
}

function restoreHistory(entry) {
  elements.sourceText.value = entry.text;
  elements.sourceLanguage.value = entry.source;
  elements.targetLanguage.value = entry.target;
  updateCharacterCount();
  savePreferences();
  showTranslation({
    text: entry.translation,
    source: entry.source,
    detectedSource: entry.detectedSource,
    target: entry.target,
    provider: entry.provider,
    warnings: ['已从本地历史记录恢复，本次没有重新请求在线翻译。'],
  });
  if (window.innerWidth < 981) {
    elements.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function translateText() {
  if (state.translating) return;
  const text = elements.sourceText.value.trim();
  if (!text) {
    showToast('先输入一段需要翻译的文字');
    elements.sourceText.classList.remove('is-shaking');
    void elements.sourceText.offsetWidth;
    elements.sourceText.classList.add('is-shaking');
    elements.sourceText.focus();
    return;
  }

  hideTranslationFeedback();
  setTranslating(true);
  elements.resultPlaceholder.hidden = false;
  elements.resultPlaceholder.querySelector('p').textContent = '正在翻译…';
  elements.resultPlaceholder.querySelector('small').textContent =
    '首次使用请确保电脑已经联网';
  elements.translatedText.hidden = true;
  elements.translationMeta.replaceChildren();
  const loading = document.createElement('span');
  loading.textContent = '正在请求在线翻译引擎';
  elements.translationMeta.append(loading);

  try {
    const result = await TranslationClient.translate({
      text,
      source: elements.sourceLanguage.value,
      target: elements.targetLanguage.value,
      onProgress: (current, total) => {
        if (total > 1) {
          loading.textContent = `正在翻译第 ${current}/${total} 段`;
        }
      },
    });
    showTranslation(result);
    if (elements.saveHistory.checked) addHistory(result);
  } catch (error) {
    showTranslationError(
      error?.message || '翻译失败，请检查网络连接后重试。',
    );
  } finally {
    elements.resultPlaceholder.querySelector('p').textContent = '译文会出现在这里';
    elements.resultPlaceholder.querySelector('small').textContent =
      '按 Ctrl + Enter 即可开始翻译';
    setTranslating(false);
  }
}

async function copyTranslation() {
  const text = state.currentTranslation?.result?.text;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.className = 'clipboard-helper';
    helper.setAttribute('readonly', '');
    document.body.append(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
  showToast('译文已复制');
}

function speakTranslation() {
  const text = state.currentTranslation?.result?.text;
  const target = state.currentTranslation?.result?.target;
  if (!text || !target) return;
  if (!('speechSynthesis' in window)) {
    showToast('当前浏览器不支持语音朗读');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = SPEECH_LOCALES[target] || target;
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
  showToast('正在朗读译文');
}

function loadSample() {
  const sample = SAMPLES[state.sampleIndex % SAMPLES.length];
  state.sampleIndex += 1;
  elements.sourceText.value = sample.text;
  elements.sourceLanguage.value = sample.source;
  elements.targetLanguage.value = sample.target;
  updateCharacterCount();
  savePreferences();
  showPlaceholder();
  elements.sourceText.focus();
  elements.sourceText.setSelectionRange(sample.text.length, sample.text.length);
}

function clearInput() {
  elements.sourceText.value = '';
  updateCharacterCount();
  hideTranslationFeedback();
  showPlaceholder();
  elements.translationMeta.replaceChildren();
  const status = document.createElement('span');
  status.textContent = '等待翻译';
  elements.translationMeta.append(status);
  elements.sourceText.focus();
}

function detectClientLanguage(text) {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/u.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/u.test(text)) return 'zh';
  return 'en';
}

function swapLanguages() {
  const previousSource = elements.sourceLanguage.value;
  const previousTarget = elements.targetLanguage.value;
  const previousText = elements.sourceText.value;
  const previousResult = state.currentTranslation?.result?.text || '';
  const detected =
    state.currentTranslation?.result?.detectedSource ||
    (previousSource === 'auto'
      ? detectClientLanguage(previousText)
      : previousSource);

  elements.sourceLanguage.value = previousTarget;
  elements.targetLanguage.value =
    detected === previousTarget ? (detected === 'en' ? 'zh' : 'en') : detected;

  if (previousResult && previousText) {
    elements.sourceText.value = previousResult;
    showTranslation({
      text: previousText,
      source: previousTarget,
      detectedSource: previousTarget,
      target: elements.targetLanguage.value,
      provider: '原文',
      warnings: [],
    });
  }
  updateCharacterCount();
  savePreferences();
}

function exportHistory() {
  if (!state.historyEntries.length) {
    showToast('暂时没有可导出的历史记录');
    return;
  }
  const blob = new Blob([JSON.stringify(state.historyEntries, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  link.href = URL.createObjectURL(blob);
  link.download = `译桥翻译历史-${date}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  showToast('历史记录已导出');
}

function clearAllHistory() {
  if (!state.historyEntries.length) {
    showToast('暂时没有可清空的历史记录');
    return;
  }
  if (!window.confirm('确定清空全部翻译历史吗？此操作无法撤销。')) return;
  state.historyEntries = [];
  persistHistory();
  elements.historySearch.value = '';
  renderHistory();
  showToast('翻译历史已清空');
}

function bindEvents() {
  elements.translateButton.addEventListener('click', translateText);
  elements.copyResult.addEventListener('click', copyTranslation);
  elements.speakResult.addEventListener('click', speakTranslation);
  elements.loadSample.addEventListener('click', loadSample);
  elements.clearText.addEventListener('click', clearInput);
  elements.swapLanguages.addEventListener('click', swapLanguages);
  elements.exportHistory.addEventListener('click', exportHistory);
  elements.clearHistory.addEventListener('click', clearAllHistory);
  window.addEventListener('online', refreshOnlineState);
  window.addEventListener('offline', refreshOnlineState);

  elements.sourceText.addEventListener('input', updateCharacterCount);
  elements.sourceText.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      translateText();
    }
  });

  [elements.sourceLanguage, elements.targetLanguage, elements.saveHistory].forEach(
    (control) => control.addEventListener('change', savePreferences),
  );

  elements.historySearch.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(renderHistory, 180);
  });

  document.querySelectorAll('[data-phrase]').forEach((button) => {
    button.addEventListener('click', () => {
      elements.sourceText.value = button.dataset.phrase;
      elements.sourceLanguage.value = button.dataset.source;
      elements.targetLanguage.value = button.dataset.target;
      updateCharacterCount();
      savePreferences();
      showPlaceholder();
      elements.sourceText.focus();
      if (window.innerWidth < 981) {
        elements.workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

function initialize() {
  restorePreferences();
  refreshOnlineState();
  updateCharacterCount();
  loadHistory();
  bindEvents();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker
      .register(new URL('sw.js', window.location.href), { scope: './' })
      .catch(() => {
        // Installation is optional; translation works without the worker.
      });
  }
}

initialize();
