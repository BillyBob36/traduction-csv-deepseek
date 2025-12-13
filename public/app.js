/**
 * Logique frontend pour l'application de traduction CSV
 * Gère l'upload, la progression SSE et le téléchargement des résultats
 */

// État global de l'application
const state = {
  files: [],
  selectedLanguage: '',
  sessionId: null,
  eventSource: null,
  translatedFiles: [],
  isTranslating: false,
  testMode: false,
  testLines: 10,
  llmProvider: 'deepseek',
  openaiApiKey: '',
  openaiTier: 3
};

// Éléments DOM
const elements = {
  uploadZone: document.getElementById('uploadZone'),
  fileInput: document.getElementById('fileInput'),
  selectFilesBtn: document.getElementById('selectFilesBtn'),
  filesList: document.getElementById('filesList'),
  filesListItems: document.getElementById('filesListItems'),
  clearFilesBtn: document.getElementById('clearFilesBtn'),
  languageSection: document.getElementById('languageSection'),
  languageSelect: document.getElementById('languageSelect'),
  estimateSection: document.getElementById('estimateSection'),
  actionSection: document.getElementById('actionSection'),
  translateBtn: document.getElementById('translateBtn'),
  progressSection: document.getElementById('progressSection'),
  progressPercent: document.getElementById('progressPercent'),
  progressFill: document.getElementById('progressFill'),
  progressFiles: document.getElementById('progressFiles'),
  progressLines: document.getElementById('progressLines'),
  currentFileName: document.getElementById('currentFileName'),
  cacheHitRate: document.getElementById('cacheHitRate'),
  currentCost: document.getElementById('currentCost'),
  resultsSection: document.getElementById('resultsSection'),
  resultDuration: document.getElementById('resultDuration'),
  resultCacheHit: document.getElementById('resultCacheHit'),
  resultCost: document.getElementById('resultCost'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  individualDownloads: document.getElementById('individualDownloads'),
  newTranslationBtn: document.getElementById('newTranslationBtn'),
  errorSection: document.getElementById('errorSection'),
  errorMessage: document.getElementById('errorMessage'),
  retryBtn: document.getElementById('retryBtn'),
  // Estimation
  estFiles: document.getElementById('estFiles'),
  estLines: document.getElementById('estLines'),
  estCost: document.getElementById('estCost'),
  estTime: document.getElementById('estTime'),
  // Test mode
  testSection: document.getElementById('testSection'),
  testLinesCount: document.getElementById('testLinesCount'),
  testHint: document.getElementById('testHint'),
  // LLM Provider
  llmSection: document.getElementById('llmSection'),
  llmProviderRadios: document.getElementsByName('llmProvider'),
  openaiConfig: document.getElementById('openaiConfig'),
  openaiApiKey: document.getElementById('openaiApiKey'),
  openaiTier: document.getElementById('openaiTier'),
  uploadSection: document.getElementById('uploadSection')
};

/**
 * Initialisation de l'application
 */
async function init() {
  // Charger les langues disponibles
  await loadLanguages();
  
  // Configurer les événements
  setupEventListeners();
}

/**
 * Charge la liste des langues depuis l'API
 */
async function loadLanguages() {
  try {
    const response = await fetch('/api/translate/languages');
    const languages = await response.json();
    
    elements.languageSelect.innerHTML = '<option value="">-- Choisir une langue --</option>';
    
    for (const [code, data] of Object.entries(languages)) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${data.name} (${data.nativeName})`;
      elements.languageSelect.appendChild(option);
    }
  } catch (error) {
    console.error('Erreur chargement langues:', error);
  }
}

/**
 * Configure tous les écouteurs d'événements
 */
function setupEventListeners() {
  // Upload zone - drag & drop
  elements.uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.uploadZone.classList.add('dragover');
  });

  elements.uploadZone.addEventListener('dragleave', () => {
    elements.uploadZone.classList.remove('dragover');
  });

  elements.uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.uploadZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  // Upload zone - click
  elements.uploadZone.addEventListener('click', () => {
    elements.fileInput.click();
  });

  elements.selectFilesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });

  // Clear files
  elements.clearFilesBtn.addEventListener('click', clearFiles);

  // Language select
  elements.languageSelect.addEventListener('change', (e) => {
    state.selectedLanguage = e.target.value;
    updateUI();
    if (state.files.length > 0 && state.selectedLanguage) {
      getEstimate();
    }
  });

  // Translate button - détermine automatiquement si c'est un test (testLines > 0)
  elements.translateBtn.addEventListener('click', () => {
    const testLines = parseInt(elements.testLinesCount.value) || 0;
    state.testLines = testLines;
    state.testMode = testLines > 0;
    startTranslation(state.testMode);
  });

  // Test lines count - met à jour le hint
  elements.testLinesCount.addEventListener('input', (e) => {
    const value = parseInt(e.target.value) || 0;
    state.testLines = value;
    state.testMode = value > 0;
    elements.testHint.textContent = value > 0 ? `Test: ${value} lignes` : 'Traduction complète';
  });

  // LLM Provider selection
  elements.llmProviderRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      state.llmProvider = e.target.value;
      elements.openaiConfig.hidden = state.llmProvider !== 'openai';
    });
  });

  // OpenAI API Key
  elements.openaiApiKey.addEventListener('input', (e) => {
    state.openaiApiKey = e.target.value;
  });

  // OpenAI Tier
  elements.openaiTier.addEventListener('change', (e) => {
    state.openaiTier = parseInt(e.target.value);
  });

  // Download buttons
  elements.downloadAllBtn.addEventListener('click', downloadAll);
  elements.newTranslationBtn.addEventListener('click', resetApp);
  elements.retryBtn.addEventListener('click', () => startTranslation(false));
}

/**
 * Gère l'ajout de fichiers
 */
function handleFiles(fileList) {
  const csvFiles = Array.from(fileList).filter(f => 
    f.type === 'text/csv' || f.name.endsWith('.csv')
  );

  if (csvFiles.length === 0) {
    showError('Veuillez sélectionner des fichiers CSV uniquement.');
    return;
  }

  state.files = [...state.files, ...csvFiles];
  updateFilesList();
  updateUI();

  if (state.selectedLanguage) {
    getEstimate();
  }
}

/**
 * Met à jour l'affichage de la liste des fichiers
 */
function updateFilesList() {
  elements.filesListItems.innerHTML = '';

  state.files.forEach((file, index) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="file-info">
        <i class="fas fa-file-csv"></i>
        <span>${file.name}</span>
      </div>
      <div>
        <span class="file-size">${formatFileSize(file.size)}</span>
        <button class="remove-file" data-index="${index}">
          <i class="fas fa-times"></i>
        </button>
      </div>
    `;
    elements.filesListItems.appendChild(li);
  });

  // Événements de suppression
  elements.filesListItems.querySelectorAll('.remove-file').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.currentTarget.dataset.index);
      state.files.splice(index, 1);
      updateFilesList();
      updateUI();
      if (state.files.length > 0 && state.selectedLanguage) {
        getEstimate();
      }
    });
  });
}

/**
 * Efface tous les fichiers sélectionnés
 */
function clearFiles() {
  state.files = [];
  elements.fileInput.value = '';
  updateFilesList();
  updateUI();
}

/**
 * Met à jour l'interface selon l'état
 */
function updateUI() {
  if (state.isTranslating) {
    elements.uploadSection.hidden = true;
    elements.filesList.hidden = true;
    elements.languageSection.hidden = true;
    elements.llmSection.hidden = true;
    elements.estimateSection.hidden = true;
    elements.testSection.hidden = true;
    elements.actionSection.hidden = true;
    return;
  }

  const hasFiles = state.files.length > 0;
  const hasLanguage = !!state.selectedLanguage;

  elements.filesList.hidden = !hasFiles;
  elements.languageSection.hidden = !hasFiles;
  elements.llmSection.hidden = !(hasFiles && hasLanguage);
  elements.estimateSection.hidden = !(hasFiles && hasLanguage);
  elements.testSection.hidden = !(hasFiles && hasLanguage);
  elements.actionSection.hidden = !(hasFiles && hasLanguage);
}

/**
 * Obtient l'estimation du coût et du temps
 */
async function getEstimate() {
  if (state.files.length === 0) return;

  const formData = new FormData();
  state.files.forEach(file => formData.append('files', file));

  try {
    const response = await fetch('/api/translate/estimate', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error('Erreur estimation');

    const data = await response.json();

    elements.estFiles.textContent = data.totalFiles;
    elements.estLines.textContent = data.totalLines.toLocaleString();
    elements.estCost.textContent = `$${data.estimatedCost.toFixed(2)}`;
    elements.estTime.textContent = `~${data.estimatedTimeMinutes} min`;

  } catch (error) {
    console.error('Erreur estimation:', error);
  }
}

/**
 * Démarre la traduction
 * @param {boolean} isTest - Si true, mode test avec nombre limité de lignes
 */
async function startTranslation(isTest = false) {
  if (state.isTranslating) return;

  // Validation OpenAI
  if (state.llmProvider === 'openai' && !state.openaiApiKey) {
    showError('Veuillez entrer votre clé API OpenAI');
    return;
  }

  state.isTranslating = true;
  state.sessionId = `session_${Date.now()}`;
  state.translatedFiles = [];

  // Masquer toutes les sections sauf progression et estimation
  elements.uploadSection.hidden = true;
  elements.filesList.hidden = true;
  elements.languageSection.hidden = true;
  elements.actionSection.hidden = true;
  elements.estimateSection.hidden = false; // Garder visible pendant la traduction
  elements.testSection.hidden = true;
  elements.llmSection.hidden = true;
  elements.errorSection.hidden = true;
  elements.resultsSection.hidden = true;
  elements.progressSection.hidden = false;
  
  console.log('[UI] Sections masquées, progression affichée');

  // Réinitialiser la progression
  updateProgress(0, 0, 0);

  // Connecter au SSE pour la progression ET ATTENDRE la connexion
  try {
    await connectSSE();
    console.log('[SSE Client] Connexion SSE établie, envoi de la requête de traduction...');
  } catch (sseError) {
    console.error('[SSE Client] Impossible de se connecter au SSE:', sseError);
    // Continuer quand même, la traduction fonctionnera mais sans progression en temps réel
  }

  // Préparer le formulaire
  const formData = new FormData();
  state.files.forEach(file => formData.append('files', file));
  formData.append('targetLanguage', state.selectedLanguage);
  formData.append('sessionId', state.sessionId);

  // LLM Provider
  formData.append('llmProvider', state.llmProvider);
  if (state.llmProvider === 'openai') {
    formData.append('openaiApiKey', state.openaiApiKey);
    formData.append('openaiTier', state.openaiTier.toString());
  }

  // Mode test : limiter le nombre de lignes
  if (isTest) {
    formData.append('testMode', 'true');
    formData.append('testLines', state.testLines.toString());
  }

  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Erreur traduction');
    }

    // Récupérer le fichier traduit
    const contentType = response.headers.get('Content-Type');
    const contentDisposition = response.headers.get('Content-Disposition');
    const filename = extractFilename(contentDisposition) || `traduction_${state.selectedLanguage}.csv`;

    const blob = await response.blob();

    // Stocker pour téléchargement
    state.translatedFiles = [{
      name: filename,
      blob: blob,
      isZip: contentType.includes('zip')
    }];

    // Afficher les résultats
    showResults();

  } catch (error) {
    showError(error.message);
  } finally {
    state.isTranslating = false;
    disconnectSSE();
  }
}

/**
 * Connecte au flux SSE pour la progression
 * Retourne une Promise qui se résout quand la connexion est établie
 */
function connectSSE() {
  return new Promise((resolve, reject) => {
    if (state.eventSource) {
      state.eventSource.close();
    }

    console.log(`[SSE Client] Connexion à /api/translate/progress/${state.sessionId}`);
    state.eventSource = new EventSource(`/api/translate/progress/${state.sessionId}`);

    // Timeout si pas de connexion après 10s
    const timeout = setTimeout(() => {
      console.error('[SSE Client] Timeout connexion');
      reject(new Error('Timeout connexion SSE'));
    }, 10000);

    state.eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('[SSE Client] Message reçu:', data.type);
      
      // Le premier message 'connected' confirme la connexion
      if (data.type === 'connected') {
        clearTimeout(timeout);
        console.log('[SSE Client] Connexion confirmée par le serveur');
        resolve();
      }
      
      handleSSEMessage(data);
    };

    state.eventSource.onerror = (err) => {
      console.error('[SSE Client] Erreur:', err);
      clearTimeout(timeout);
      // Ne pas rejeter, le SSE peut se reconnecter automatiquement
    };
  });
}

/**
 * Déconnecte le SSE
 */
function disconnectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

/**
 * Gère les messages SSE
 */
function handleSSEMessage(data) {
  switch (data.type) {
    case 'init':
      elements.progressLines.textContent = `0/${data.totalLines.toLocaleString()}`;
      elements.progressFiles.textContent = `0/${data.totalFiles}`;
      // Afficher info déduplication si disponible
      if (data.totalUnique && data.deduplicationSaved > 0) {
        console.log(`[Déduplication] ${data.totalLines} lignes → ${data.totalUnique} uniques (${data.deduplicationSaved} économisées)`);
      }
      break;

    case 'file_start':
      elements.currentFileName.textContent = data.fileName;
      // Afficher info déduplication et batches du fichier
      if (data.uniqueToTranslate) {
        let info = `${data.fileName} (${data.uniqueToTranslate} uniques / ${data.linesToTranslate} lignes)`;
        if (data.totalBatches) {
          info += ` - ${data.totalBatches} batches`;
        }
        elements.currentFileName.textContent = info;
      }
      // Réinitialiser la progression des batches
      if (data.totalBatches) {
        elements.progressLines.textContent = `0/${data.linesToTranslate} (batch 0/${data.totalBatches})`;
      }
      break;

    case 'progress':
      updateProgress(
        data.percentComplete,
        data.globalProcessedLines || 0,
        data.globalTotalLines || 0,
        data.batchesCompleted,
        data.totalBatches
      );
      
      if (data.cacheStats) {
        // Pour OpenAI, afficher le coût estimé
        if (data.cacheStats.estimatedCost !== undefined) {
          elements.cacheHitRate.textContent = `${data.cacheStats.requestCount || 0} req`;
          elements.currentCost.textContent = `$${data.cacheStats.estimatedCost.toFixed(4)}`;
        } else {
          elements.cacheHitRate.textContent = `${data.cacheStats.hitRate}%`;
          elements.currentCost.textContent = `$${data.cacheStats.estimatedCost?.toFixed(4) || '0.00'}`;
        }
      }
      break;

    case 'file_complete':
      const completedFiles = parseInt(elements.progressFiles.textContent.split('/')[0]) + 1;
      const totalFiles = data.fileIndex !== undefined ? state.files.length : 1;
      elements.progressFiles.textContent = `${completedFiles}/${totalFiles}`;
      break;

    case 'complete':
      elements.resultDuration.textContent = `${data.duration}s`;
      elements.resultCacheHit.textContent = `${data.cacheStats.hitRate}%`;
      elements.resultCost.textContent = `$${data.cacheStats.estimatedCost.toFixed(4)}`;
      // Afficher économies de déduplication
      if (data.deduplication) {
        console.log(`[Résultat] Déduplication: ${data.deduplication.original} → ${data.deduplication.unique} (${data.deduplication.saved} économisées)`);
      }
      break;

    case 'error':
      showError(data.message);
      break;
  }
}

/**
 * Met à jour la barre de progression
 */
function updateProgress(percent, processed, total, batchesCompleted, totalBatches) {
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressFill.style.width = `${percent}%`;
  
  // Afficher les lignes et optionnellement les batches
  let linesText = `${processed.toLocaleString()}/${total.toLocaleString()}`;
  if (batchesCompleted !== undefined && totalBatches !== undefined) {
    linesText += ` (batch ${batchesCompleted}/${totalBatches})`;
  }
  elements.progressLines.textContent = linesText;
}

/**
 * Affiche la section résultats
 */
function showResults() {
  elements.progressSection.hidden = true;
  elements.resultsSection.hidden = false;

  // Afficher les téléchargements individuels si plusieurs fichiers
  elements.individualDownloads.innerHTML = '';
  
  if (state.translatedFiles.length > 0 && !state.translatedFiles[0].isZip) {
    state.translatedFiles.forEach((file, index) => {
      const div = document.createElement('div');
      div.className = 'download-item';
      div.innerHTML = `
        <span><i class="fas fa-file-csv"></i> ${file.name}</span>
        <button class="btn btn-secondary" data-index="${index}">
          <i class="fas fa-download"></i> Télécharger
        </button>
      `;
      elements.individualDownloads.appendChild(div);
    });

    elements.individualDownloads.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.currentTarget.dataset.index);
        downloadFile(state.translatedFiles[index]);
      });
    });
  }
}

/**
 * Télécharge tous les fichiers
 */
function downloadAll() {
  if (state.translatedFiles.length === 0) return;

  // Si c'est déjà un ZIP, télécharger directement
  if (state.translatedFiles[0].isZip) {
    downloadFile(state.translatedFiles[0]);
    return;
  }

  // Sinon, télécharger le premier fichier (cas d'un seul CSV)
  downloadFile(state.translatedFiles[0]);
}

/**
 * Télécharge un fichier
 */
function downloadFile(file) {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Affiche une erreur
 */
function showError(message) {
  elements.progressSection.hidden = true;
  elements.resultsSection.hidden = true;
  elements.errorSection.hidden = false;
  elements.errorMessage.textContent = message;
  state.isTranslating = false;
}

/**
 * Réinitialise l'application
 */
function resetApp() {
  state.files = [];
  state.selectedLanguage = '';
  state.translatedFiles = [];
  state.isTranslating = false;

  elements.fileInput.value = '';
  elements.languageSelect.value = '';
  elements.filesListItems.innerHTML = '';
  elements.individualDownloads.innerHTML = '';

  elements.resultsSection.hidden = true;
  elements.errorSection.hidden = true;
  elements.progressSection.hidden = true;
  elements.filesList.hidden = true;
  elements.languageSection.hidden = true;
  elements.llmSection.hidden = true;
  elements.estimateSection.hidden = true;
  elements.testSection.hidden = true;
  elements.actionSection.hidden = true;
  elements.uploadSection.hidden = false;

  // Reset test mode
  state.testMode = false;
  state.testLines = 0;
  elements.testLinesCount.value = '0';
  elements.testHint.textContent = 'Traduction complète';

  // Reset LLM provider
  state.llmProvider = 'deepseek';
  state.openaiApiKey = '';
  state.openaiTier = 3;
  elements.llmProviderRadios[0].checked = true; // DeepSeek
  elements.openaiConfig.hidden = true;
  elements.openaiApiKey.value = '';
  elements.openaiTier.value = '3';
}

/**
 * Formate la taille d'un fichier
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * Extrait le nom de fichier du header Content-Disposition
 */
function extractFilename(contentDisposition) {
  if (!contentDisposition) return null;
  const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  if (match && match[1]) {
    return match[1].replace(/['"]/g, '');
  }
  return null;
}

// Lancer l'application
document.addEventListener('DOMContentLoaded', init);
