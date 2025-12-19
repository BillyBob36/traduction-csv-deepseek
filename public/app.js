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
  translationSessionId: null, // Session pour téléchargement des résultats
  isTranslating: false,
  testMode: false,
  testLines: 0,
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
  uploadSection: document.getElementById('uploadSection'),
  // Historique
  historySection: document.getElementById('historySection'),
  historyToggle: document.getElementById('historyToggle'),
  historyContent: document.getElementById('historyContent'),
  historyList: document.getElementById('historyList'),
  historyBadge: document.getElementById('historyBadge'),
  historyArrow: document.getElementById('historyArrow')
};

/**
 * Initialisation de l'application
 */
async function init() {
  // Charger les langues disponibles
  await loadLanguages();
  
  // Charger l'historique des traductions
  await loadHistory();
  
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

  // Test lines count - met à jour le hint et recalcule l'estimation
  elements.testLinesCount.addEventListener('input', (e) => {
    const value = parseInt(e.target.value) || 0;
    state.testLines = value;
    state.testMode = value > 0;
    elements.testHint.textContent = value > 0 ? `Test: ${value} lignes` : 'Traduction complète';
    // Recalculer l'estimation avec le nouveau nombre de lignes
    if (state.files.length > 0 && state.selectedLanguage) {
      getEstimate();
    }
  });

  // LLM Provider selection - recalcule l'estimation
  elements.llmProviderRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      state.llmProvider = e.target.value;
      elements.openaiConfig.hidden = state.llmProvider !== 'openai';
      // Recalculer l'estimation avec le nouveau provider
      if (state.files.length > 0 && state.selectedLanguage) {
        getEstimate();
      }
    });
  });

  // OpenAI API Key
  elements.openaiApiKey.addEventListener('input', (e) => {
    state.openaiApiKey = e.target.value;
  });

  // OpenAI Tier - recalcule l'estimation
  elements.openaiTier.addEventListener('change', (e) => {
    state.openaiTier = parseInt(e.target.value);
    // Recalculer l'estimation avec le nouveau tier
    if (state.files.length > 0 && state.selectedLanguage && state.llmProvider === 'openai') {
      getEstimate();
    }
  });

  // Download buttons
  elements.downloadAllBtn.addEventListener('click', downloadAll);
  elements.newTranslationBtn.addEventListener('click', resetApp);
  elements.retryBtn.addEventListener('click', () => startTranslation(false));

  // Historique toggle
  elements.historyToggle.addEventListener('click', toggleHistory);
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
 * Prend en compte le provider et le nombre de lignes test
 */
async function getEstimate() {
  if (state.files.length === 0) return;

  const formData = new FormData();
  state.files.forEach(file => formData.append('files', file));
  formData.append('llmProvider', state.llmProvider);
  formData.append('testLines', state.testLines.toString());
  formData.append('openaiTier', state.openaiTier.toString());

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

    // Lire la réponse en texte d'abord pour vérifier si c'est du JSON
    const responseText = await response.text();
    
    // Vérifier si la réponse est du HTML (erreur serveur)
    if (responseText.trim().startsWith('<') || responseText.includes('<!DOCTYPE')) {
      throw new Error('Le serveur a renvoyé une erreur. Veuillez réessayer.');
    }
    
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error('Réponse invalide du serveur. Veuillez réessayer.');
    }

    if (!response.ok) {
      throw new Error(data.error || 'Erreur traduction');
    }
    
    if (!data.success) {
      throw new Error(data.error || 'Erreur traduction');
    }

    // La réponse confirme le démarrage - les résultats arrivent via SSE 'complete'
    console.log('[Traduction] Démarrée en arrière-plan, attente du SSE complete...');
    // Le SSE 'complete' appellera showResults() avec les infos de fichiers

  } catch (error) {
    showError(error.message);
    state.isTranslating = false;
    disconnectSSE();
  }
  // Note: isTranslating et disconnectSSE sont maintenant gérés dans handleSSEMessage 'complete'
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
      
      // Reconnexion automatique si la traduction est toujours en cours
      if (state.isTranslating && state.eventSource) {
        console.log('[SSE Client] Déconnexion détectée, reconnexion dans 2s...');
        state.eventSource.close();
        state.eventSource = null;
        
        setTimeout(() => {
          if (state.isTranslating) {
            console.log('[SSE Client] Tentative de reconnexion...');
            connectSSE().catch(e => console.error('[SSE Client] Échec reconnexion:', e));
          }
        }, 2000);
      }
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
      console.log('[SSE] Traduction terminée, réception des fichiers');
      
      // Stocker les infos pour téléchargement (reçues via SSE)
      if (data.files && data.files.length > 0) {
        state.translatedFiles = data.files.map(f => ({
          name: f.name,
          size: f.size,
          index: f.index,
          isPartOfSplit: f.isPartOfSplit,
          totalParts: f.totalParts
        }));
      }
      
      // Mettre à jour les stats
      elements.resultDuration.textContent = `${data.duration}s`;
      elements.resultCacheHit.textContent = `${data.cacheStats?.hitRate || 0}%`;
      elements.resultCost.textContent = `$${(data.cacheStats?.estimatedCost || 0).toFixed(4)}`;
      
      // Afficher économies de déduplication
      if (data.deduplication) {
        console.log(`[Résultat] Déduplication: ${data.deduplication.original} → ${data.deduplication.unique} (${data.deduplication.saved} économisées)`);
      }
      
      // Terminer la traduction et afficher les résultats
      state.isTranslating = false;
      disconnectSSE();
      showResults();
      
      // Rafraîchir l'historique
      loadHistory();
      break;

    case 'error':
      state.isTranslating = false;
      disconnectSSE();
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

  // Afficher les téléchargements individuels
  elements.individualDownloads.innerHTML = '';
  
  if (state.translatedFiles.length > 0) {
    // Afficher info si fichiers découpés
    const hasSplitFiles = state.translatedFiles.some(f => f.isPartOfSplit);
    if (hasSplitFiles) {
      const infoDiv = document.createElement('div');
      infoDiv.className = 'split-info';
      infoDiv.innerHTML = `<i class="fas fa-info-circle"></i> Fichier(s) découpé(s) car > 10 Mo`;
      infoDiv.style.cssText = 'color: var(--warning-color); margin-bottom: 1rem; font-size: 0.9rem;';
      elements.individualDownloads.appendChild(infoDiv);
    }
    
    state.translatedFiles.forEach((file) => {
      const sizeKB = (file.size / 1024).toFixed(1);
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);
      const sizeDisplay = file.size > 1024 * 1024 ? `${sizeMB} Mo` : `${sizeKB} Ko`;
      
      const div = document.createElement('div');
      div.className = 'download-item';
      div.innerHTML = `
        <span><i class="fas fa-file-csv"></i> ${file.name} <small>(${sizeDisplay})</small></span>
        <button class="btn btn-secondary" data-index="${file.index}">
          <i class="fas fa-download"></i> Télécharger
        </button>
      `;
      elements.individualDownloads.appendChild(div);
    });

    elements.individualDownloads.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.currentTarget.dataset.index);
        downloadFileByIndex(index);
      });
    });
  }
}

/**
 * Télécharge tous les fichiers en ZIP
 */
function downloadAll() {
  if (state.translatedFiles.length === 0 || !state.translationSessionId) return;

  // Télécharger le ZIP via la route API
  const url = `/api/translate/download-zip/${state.translationSessionId}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `traductions_${state.selectedLanguage}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Télécharge un fichier individuel par son index
 */
function downloadFileByIndex(index) {
  if (!state.translationSessionId) return;
  
  const file = state.translatedFiles.find(f => f.index === index);
  if (!file) return;
  
  const url = `/api/translate/download/${state.translationSessionId}/${index}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
  state.translationSessionId = null;
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

/**
 * Charge l'historique des traductions depuis le serveur
 */
async function loadHistory() {
  try {
    const response = await fetch('/api/translate/history');
    const data = await response.json();
    
    if (data.success) {
      renderHistory(data.history);
      elements.historyBadge.textContent = data.count;
    }
  } catch (error) {
    console.error('[Historique] Erreur chargement:', error);
  }
}

/**
 * Toggle l'affichage de l'historique
 */
function toggleHistory() {
  const isHidden = elements.historyContent.hidden;
  elements.historyContent.hidden = !isHidden;
  elements.historyArrow.classList.toggle('open', isHidden);
}

/**
 * Affiche l'historique des traductions
 */
function renderHistory(history) {
  if (!history || history.length === 0) {
    elements.historyList.innerHTML = '<p class="history-empty">Aucune traduction dans l\'historique</p>';
    return;
  }
  
  elements.historyList.innerHTML = history.map(item => {
    const date = new Date(item.createdAt);
    const dateStr = date.toLocaleDateString('fr-FR', { 
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    
    const filesNames = item.files.map(f => f.name).join(', ');
    const totalSize = item.files.reduce((sum, f) => sum + f.size, 0);
    
    return `
      <div class="history-item" data-session="${item.sessionId}">
        <div class="history-item-info">
          <div class="history-item-date">${dateStr}</div>
          <div class="history-item-files" title="${filesNames}">
            ${item.totalFiles} fichier(s) - ${formatFileSize(totalSize)}
          </div>
          <div class="history-item-meta">
            <span class="history-lang-badge">${item.targetLanguage}</span>
            ${item.duration ? `<span>${item.duration}s</span>` : ''}
          </div>
        </div>
        <div class="history-item-actions">
          <button class="btn btn-secondary" onclick="downloadHistoryZip('${item.sessionId}')">
            <i class="fas fa-download"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Télécharge le ZIP d'une session depuis l'historique
 */
async function downloadHistoryZip(sessionId) {
  try {
    const response = await fetch(`/api/translate/history/${sessionId}/download-zip`);
    
    if (!response.ok) {
      throw new Error('Session non trouvée');
    }
    
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `traductions_${sessionId}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('[Historique] Erreur téléchargement:', error);
    showError('Impossible de télécharger depuis l\'historique: ' + error.message);
  }
}

// Lancer l'application
document.addEventListener('DOMContentLoaded', init);
